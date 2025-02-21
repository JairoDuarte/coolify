import { asyncExecShell, createDirectories, getEngine, getUserDetails } from '$lib/common';
import * as db from '$lib/database';
import { promises as fs } from 'fs';
import yaml from 'js-yaml';
import type { RequestHandler } from '@sveltejs/kit';
import { letsEncrypt } from '$lib/letsencrypt';
import {
	checkHAProxy,
	configureSimpleServiceProxyOn,
	reloadHaproxy,
	setWwwRedirection
} from '$lib/haproxy';
import { getDomain } from '$lib/components/common';
import { ErrorHandler } from '$lib/database';

export const post: RequestHandler = async (event) => {
	const { teamId, status, body } = await getUserDetails(event);
	if (status === 401) return { status, body };

	const { id } = event.params;

	try {
		await checkHAProxy();
		const service = await db.getService({ id, teamId });
		const {
			type,
			version,
			fqdn,
			destinationDockerId,
			destinationDocker,
			plausibleAnalytics: {
				id: plausibleDbId,
				username,
				email,
				password,
				postgresqlDatabase,
				postgresqlPassword,
				postgresqlUser,
				secretKeyBase
			}
		} = service;

		const domain = getDomain(fqdn);
		const isHttps = fqdn.startsWith('https://');

		const config = {
			plausibleAnalytics: {
				image: `plausible/analytics:${version}`,
				environmentVariables: {
					ADMIN_USER_EMAIL: email,
					ADMIN_USER_NAME: username,
					ADMIN_USER_PWD: password,
					BASE_URL: fqdn,
					SECRET_KEY_BASE: secretKeyBase,
					DISABLE_AUTH: 'false',
					DISABLE_REGISTRATION: 'true',
					DATABASE_URL: `postgresql://${postgresqlUser}:${postgresqlPassword}@${id}-postgresql:5432/${postgresqlDatabase}`,
					CLICKHOUSE_DATABASE_URL: `http://${id}-clickhouse:8123/plausible`
				}
			},
			postgresql: {
				volume: `${plausibleDbId}-postgresql-data:/var/lib/postgresql/data`,
				image: 'bitnami/postgresql:13.2.0',
				environmentVariables: {
					POSTGRESQL_PASSWORD: postgresqlPassword,
					POSTGRESQL_USERNAME: postgresqlUser,
					POSTGRESQL_DATABASE: postgresqlDatabase
				}
			},
			clickhouse: {
				volume: `${plausibleDbId}-clickhouse-data:/var/lib/clickhouse`,
				image: 'yandex/clickhouse-server:21.3.2.5',
				environmentVariables: {},
				ulimits: {
					nofile: {
						soft: 262144,
						hard: 262144
					}
				}
			}
		};
		const network = destinationDockerId && destinationDocker.network;
		const host = getEngine(destinationDocker.engine);
		const engine = destinationDocker.engine;
		// const labels = await makeLabelForPlausibleAnalytics({ id,  })

		const { workdir } = await createDirectories({ repository: type, buildId: id });

		const clickhouseConfigXml = `
        <yandex>
          <logger>
              <level>warning</level>
              <console>true</console>
          </logger>
    
          <!-- Stop all the unnecessary logging -->
          <query_thread_log remove="remove"/>
          <query_log remove="remove"/>
          <text_log remove="remove"/>
          <trace_log remove="remove"/>
          <metric_log remove="remove"/>
          <asynchronous_metric_log remove="remove"/>
      </yandex>`;
		const clickhouseUserConfigXml = `
        <yandex>
          <profiles>
              <default>
                  <log_queries>0</log_queries>
                  <log_query_threads>0</log_query_threads>
              </default>
          </profiles>
      </yandex>`;

		const initQuery = 'CREATE DATABASE IF NOT EXISTS plausible;';
		const initScript = 'clickhouse client --queries-file /docker-entrypoint-initdb.d/init.query';
		await fs.writeFile(`${workdir}/clickhouse-config.xml`, clickhouseConfigXml);
		await fs.writeFile(`${workdir}/clickhouse-user-config.xml`, clickhouseUserConfigXml);
		await fs.writeFile(`${workdir}/init.query`, initQuery);
		await fs.writeFile(`${workdir}/init-db.sh`, initScript);

		const Dockerfile = `
FROM ${config.clickhouse.image}
COPY ./clickhouse-config.xml /etc/clickhouse-server/users.d/logging.xml
COPY ./clickhouse-user-config.xml /etc/clickhouse-server/config.d/logging.xml
COPY ./init.query /docker-entrypoint-initdb.d/init.query
COPY ./init-db.sh /docker-entrypoint-initdb.d/init-db.sh`;

		await fs.writeFile(`${workdir}/Dockerfile`, Dockerfile);
		const composeFile = {
			version: '3.8',
			services: {
				[id]: {
					container_name: id,
					image: config.plausibleAnalytics.image,
					command:
						'sh -c "sleep 10 && /entrypoint.sh db createdb && /entrypoint.sh db migrate && /entrypoint.sh db init-admin && /entrypoint.sh run"',
					networks: [network],
					environment: config.plausibleAnalytics.environmentVariables,
					volumes: [config.postgresql.volume],
					restart: 'always',
					depends_on: [`${id}-postgresql`, `${id}-clickhouse`]
				},
				[`${id}-postgresql`]: {
					container_name: `${id}-postgresql`,
					image: config.postgresql.image,
					networks: [network],
					environment: config.postgresql.environmentVariables,
					volumes: [config.postgresql.volume],
					restart: 'always'
				},
				[`${id}-clickhouse`]: {
					build: workdir,
					container_name: `${id}-clickhouse`,
					networks: [network],
					environment: config.clickhouse.environmentVariables,
					volumes: [config.clickhouse.volume],
					restart: 'always'
				}
			},
			networks: {
				[network]: {
					external: true
				}
			},
			volumes: {
				[config.postgresql.volume.split(':')[0]]: {
					external: true
				},
				[config.clickhouse.volume.split(':')[0]]: {
					external: true
				}
			}
		};
		const composeFileDestination = `${workdir}/docker-compose.yaml`;
		await fs.writeFile(composeFileDestination, yaml.dump(composeFile));
		try {
			await asyncExecShell(
				`DOCKER_HOST=${host} docker volume create ${config.postgresql.volume.split(':')[0]}`
			);
			await asyncExecShell(
				`DOCKER_HOST=${host} docker volume create ${config.clickhouse.volume.split(':')[0]}`
			);
		} catch (error) {
			console.log(error);
		}
		await asyncExecShell(
			`DOCKER_HOST=${host} docker compose -f ${composeFileDestination} up --build -d`
		);
		await configureSimpleServiceProxyOn({ id, domain, port: 8000 });

		if (isHttps) {
			await letsEncrypt({ domain, id });
		}
		await setWwwRedirection(fqdn);
		await reloadHaproxy(destinationDocker.engine);
		return {
			status: 200
		};
	} catch (error) {
		return ErrorHandler(error);
	}
};
