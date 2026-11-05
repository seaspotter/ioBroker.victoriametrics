import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The docker plugin reads docker-compose.yaml, substitutes ${config.*} from the *instance* native config
// and creates every service whose iobEnabled label ends up truthy. An instance upgraded from a version
// without Docker support has no dockerVictoria in its native config at all, so the ":-" defaults decide
// what happens - and they must never opt anybody into containers they did not ask for.
describe('docker-compose.yaml', function () {
    const composeFile = path.join(__dirname, '..', 'docker-compose.yaml');
    const yaml = fs.readFileSync(composeFile, 'utf-8');

    interface ContainerConfig {
        name: string;
        iobEnabled?: boolean;
        command?: string[];
        [key: string]: unknown;
    }

    interface PluginInternals {
        parse: (yaml: string) => unknown;
        composeToContainerConfigs: (compose: unknown) => ContainerConfig[];
        walkTheConfig: (compose: unknown, native: unknown, options: { instance: number }) => unknown;
    }

    /**
     * The plugin exposes only its index, so the parser is loaded by path. If that internal layout ever
     * changes, the tests using it are skipped instead of failing - the label check below still guards the file.
     */
    function loadPluginInternals(): PluginInternals | null {
        try {
            const root = path.dirname(require.resolve('@iobroker/plugin-docker/package.json'));
            const lib = path.join(root, 'build', 'cjs', 'lib');
            /* eslint-disable @typescript-eslint/no-require-imports */
            const parseDockerCompose = require(path.join(lib, 'parseDockerCompose.js'));
            const { composeToContainerConfigs } = require(path.join(lib, 'compose2config.js'));
            const { walkTheConfig } = require(path.join(lib, 'templates.js'));
            /* eslint-enable @typescript-eslint/no-require-imports */
            return {
                parse: parseDockerCompose.default || parseDockerCompose,
                composeToContainerConfigs,
                walkTheConfig,
            };
        } catch {
            return null;
        }
    }

    /**
     * Renders the compose file with the given instance native config and returns the resulting services
     *
     * @param native - Native config of the instance
     */
    function renderWith(native: Record<string, unknown>): ContainerConfig[] | null {
        const plugin = loadPluginInternals();
        if (!plugin) {
            return null;
        }
        const rendered = plugin.walkTheConfig(plugin.parse(yaml), native, { instance: 0 });
        return plugin.composeToContainerConfigs(rendered);
    }

    it('every iobEnabled label defaults to false', function () {
        const labels = yaml.match(/iobEnabled=\S+?'/g) || [];
        assert.ok(labels.length >= 1, `expected iobEnabled labels, found ${labels.length}`);
        for (const label of labels) {
            assert.ok(
                label.includes(':-false}'),
                `${label} must use ":-false" as default, otherwise instances without that config key get the container created`,
            );
        }
    });

    it('no container is enabled when the instance config has no docker settings', function () {
        // native of an instance that was upgraded from a version without Docker support
        const configs = renderWith({ protocol: 'http', host: 'localhost', port: 8428 });
        if (!configs) {
            return this.skip();
        }

        assert.ok(configs.length, 'expected the compose file to declare services');
        for (const config of configs) {
            assert.equal(
                !!config.iobEnabled,
                false,
                `service "${config.name}" would be created although docker was never enabled`,
            );
        }
    });

    it('no container is enabled with the defaults from io-package.json', function () {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const native = JSON.parse(JSON.stringify(require('../io-package.json').native)) as Record<string, unknown>;
        const configs = renderWith(native);
        if (!configs) {
            return this.skip();
        }

        for (const config of configs) {
            assert.equal(!!config.iobEnabled, false, `service "${config.name}" is enabled by default`);
        }
    });

    it('the container is created when docker is enabled in the instance config', function () {
        const configs = renderWith({ dockerVictoria: { enabled: true } });
        if (!configs) {
            return this.skip();
        }

        assert.equal(configs.length, 1);
        assert.equal(!!configs[0].iobEnabled, true);
    });

    it('passes the configured retention to VictoriaMetrics', function () {
        const configs = renderWith({ dockerVictoria: { enabled: true, retentionPeriod: '12' } });
        if (!configs) {
            return this.skip();
        }

        const command = JSON.stringify(configs[0].command || configs[0]);
        assert.ok(command.includes('-retentionPeriod=12'), `retention not passed: ${command}`);
    });

    it('defaults the retention to 100y', function () {
        const configs = renderWith({ dockerVictoria: { enabled: true } });
        if (!configs) {
            return this.skip();
        }

        const command = JSON.stringify(configs[0].command || configs[0]);
        assert.ok(command.includes('-retentionPeriod=100y'), `default retention missing: ${command}`);
    });
});
