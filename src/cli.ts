#!/usr/bin/env node

import { Command } from 'commander';
import { Hub, HubOpts } from '~/hub';

/** A CLI to accept options from the user and start the Hub */

const app = new Command();

app
  .name('hub')
  .description('Farcaster Hub')
  .version(process.env.npm_package_version ?? '1.0.0');

app
  .option('-N, --network-url <url>', 'ID Registry network URL')
  .option('-A, --id-registry-address <address>', 'ID Registry address')
  .option('-B, --bootstrap-addresses <addresses...>', 'A list of MultiAddrs to use for bootstrapping')
  .option('--port <port>', 'The port libp2p should listen on. (default: selects one at random')
  .option('--rpc-port <port>', 'The RPC port to use. (default: selects one at random')
  .option('--simple-sync <enabled>', 'Enable/Disable simple sync', true)
  .option('--db-reset', 'Clear the database before starting', false)
  .option('--db-name <name>', 'The name of the RocksDB instance', 'rocks.hub._default');

const teardown = async (hub: Hub) => {
  await hub.stop();
  process.exit();
};

app.parse(process.argv);
const cliOptions = app.opts();
const options: HubOpts = {
  networkUrl: cliOptions.networkUrl,
  IDRegistryAddress: cliOptions.idRegistryAddress,
  bootstrapAddrs: cliOptions.bootstrapAddresses,
  port: cliOptions.port,
  rpcPort: cliOptions.rpcPort,
  simpleSync: cliOptions.simpleSync,
  rocksDBName: cliOptions.dbName,
  resetDB: cliOptions.dbReset,
};

const hub = new Hub(options);
hub.start();

process.stdin.resume();

process.on('SIGINT', async () => {
  await teardown(hub);
});

process.on('SIGTERM', async () => {
  await teardown(hub);
});

process.on('SIGQUIT', async () => {
  await teardown(hub);
});
