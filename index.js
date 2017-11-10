'use strict';

const Executor = require('screwdriver-executor-base');
const path = require('path');
const Fusebox = require('circuit-fuses');
const requestretry = require('requestretry');
const randomstring = require('randomstring');
const tinytim = require('tinytim');
const yaml = require('js-yaml');
const fs = require('fs');
const MAXATTEMPTS = 3;
const RETRYDELAY = 3000;

class K8sVMExecutor extends Executor {
    /**
     * Constructor
     * @method constructor
     * @param  {Object} options                                      Configuration options
     * @param  {Object} options.ecosystem                            Screwdriver Ecosystem
     * @param  {Object} options.ecosystem.api                        Routable URI to Screwdriver API
     * @param  {Object} options.ecosystem.store                      Routable URI to Screwdriver Store
     * @param  {Object} options.kubernetes                           Kubernetes configuration
     * @param  {String} [options.kubernetes.token]                   API Token (loaded from /var/run/secrets/kubernetes.io/serviceaccount/token if not provided)
     * @param  {String} [options.kubernetes.host=kubernetes.default] Kubernetes hostname
     * @param  {String} [options.kubernetes.jobsNamespace=default]   Pods namespace for Screwdriver Jobs
     * @param  {String} [options.kubernetes.baseImage]               Base image for the pod
     * @param  {String} [options.launchVersion=stable]               Launcher container version to use
     * @param  {String} [options.prefix='']                          Prefix for job name
     * @param  {String} [options.fusebox]                            Options for the circuit breaker (https://github.com/screwdriver-cd/circuit-fuses)
     */
    constructor(options = {}) {
        super();

        this.kubernetes = options.kubernetes || {};
        this.ecosystem = options.ecosystem;

        if (this.kubernetes.token) {
            this.token = this.kubernetes.token;
        } else {
            const filepath = '/var/run/secrets/kubernetes.io/serviceaccount/token';

            this.token = fs.existsSync(filepath) ? fs.readFileSync(filepath) : '';
        }
        this.host = this.kubernetes.host || 'kubernetes.default';
        this.launchVersion = options.launchVersion || 'stable';
        this.prefix = options.prefix || '';
        this.jobsNamespace = this.kubernetes.jobsNamespace || 'default';
        this.baseImage = this.kubernetes.baseImage;
        this.podsUrl = `https://${this.host}/api/v1/namespaces/${this.jobsNamespace}/pods`;
        this.breaker = new Fusebox(requestretry, options.fusebox);
        this.podRetryStrategy = (err, response, body) => {
            const status = body.status.phase.toLowerCase();

            return err || status === 'pending';
        };
    }

    /**
     * Starts a k8s build
     * @method start
     * @param  {Object}   config            A configuration object
     * @param  {Integer}  config.buildId    ID for the build
     * @param  {String}   config.container  Container for the build to run in
     * @param  {String}   config.token      JWT for the Build
     * @return {Promise}
     */
    _start(config) {
        const random = randomstring.generate({
            length: 5,
            charset: 'alphanumeric',
            capitalization: 'lowercase'
        });
        const podTemplate = tinytim.renderFile(path.resolve(__dirname, './config/pod.yaml.tim'), {
            pod_name: `${this.prefix}${config.buildId}-${random}`,
            build_id_with_prefix: `${this.prefix}${config.buildId}`,
            build_id: config.buildId,
            container: config.container,
            api_uri: this.ecosystem.api,
            store_uri: this.ecosystem.store,
            token: config.token,
            launcher_version: this.launchVersion,
            base_image: this.baseImage
        });
        const options = {
            uri: this.podsUrl,
            method: 'POST',
            body: yaml.safeLoad(podTemplate),
            headers: { Authorization: `Bearer ${this.token}` },
            strictSSL: false,
            json: true
        };

        return this.breaker.runCommand(options)
            .then((resp) => {
                if (resp.statusCode !== 201) {
                    throw new Error(`Failed to create pod: ${JSON.stringify(resp.body)}`);
                }

                return resp.body.metadata.name;
            })
            .then((podname) => {
                const statusOptions = {
                    uri: `${this.podsUrl}/${podname}/status`,
                    method: 'GET',
                    headers: { Authorization: `Bearer ${this.token}` },
                    strictSSL: false,
                    maxAttempts: MAXATTEMPTS,
                    retryDelay: RETRYDELAY,
                    retryStrategy: this.podRetryStrategy
                };

                return this.breaker.runCommand(statusOptions);
            })
            .then((resp) => {
                if (resp.statusCode !== 200) {
                    throw new Error(`Failed to get pod status: ${JSON.stringify(resp.body)}`);
                }

                const status = resp.body.status.phase.toLowerCase();

                if (status === 'failed' || status === 'unknown') {
                    throw new Error(
                        `Failed to create pod. Pod status is: ${JSON.stringify(resp.body)}`);
                }

                return null;
            });
    }

    /**
     * Stop a k8s build
     * @method stop
     * @param  {Object}   config            A configuration object
     * @param  {Integer}  config.buildId    ID for the build
     * @return {Promise}
     */
    _stop(config) {
        const options = {
            uri: this.podsUrl,
            method: 'DELETE',
            qs: {
                labelSelector: `sdbuild=${this.prefix}${config.buildId}`
            },
            headers: {
                Authorization: `Bearer ${this.token}`
            },
            strictSSL: false
        };

        return this.breaker.runCommand(options)
            .then((resp) => {
                if (resp.statusCode !== 200) {
                    throw new Error(`Failed to delete pod: ${JSON.stringify(resp.body)}`);
                }

                return null;
            });
    }

    /**
    * Retreive stats for the executor
    * @method stats
    * @param  {Response} Object          Object containing stats for the executor
    */
    stats() {
        return this.breaker.stats();
    }
}

module.exports = K8sVMExecutor;
