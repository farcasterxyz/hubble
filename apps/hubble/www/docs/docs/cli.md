# CLI

Documentation for the Hubble CLI.

1. `start` - start hubble and configure how it should run
2. `identity` - generate or validate hub identities
3. `status` - status reports on sync, storage and other systems.
4. `dbreset` - clear the database.
5. `profile` - profile the storage usage of the db.
6. `console` - start an interactive repl console for debugging.

Commands must be invoked with yarn by running:

```
# if using docker
docker compose exec hubble yarn <command>

# if not using docker
yarn <command>
```

### start

```
Usage: yarn start [options]

Start a Hub

Hubble Options:
  -n --network <network>                ID of the Farcaster Network (default: 3 (devnet))
  -i, --id <filepath>                   Path to the PeerId file.
  --hub-operator-fid <fid>              The FID of the hub operator. Optional.
  -c, --config <filepath>               Path to the config file.
  --db-name <name>                      The name of the RocksDB instance. (default: rocks.hub._default)
  --process-file-prefix <prefix>        Prefix for file to which hub process number is written. (default: "")
  --log-individual-messages             Log individual submitMessage status. If disabled, log one line per second (default: disabled)"

Ethereum Options:
  -m, --eth-mainnet-rpc-url <url>       RPC URL of a Mainnet ETH Node (or comma separated list of URLs)
  -l, --l2-rpc-url <url>                RPC URL of a Goerli Optimism Node (or comma separated list of URLs)
  --rank-rpcs                           Rank the RPCs by latency/stability and use the fastest one (default: disabled)
  --fname-server-url <url>              The URL for the FName registry server (default: https://fnames.farcaster.xyz)

L2 Options:
  --l2-id-registry-address                The address of the L2 Farcaster ID Registry contract
  --l2-key-registry-address <address>     The address of the L2 Farcaster Key Registry contract
  --l2-storage-registry-address <address> The address of the L2 Farcaster Storage Registry contract
  --l2-resync-events                      Resync events from the L2 Farcaster contracts before starting (default: disabled)
  --l2-clear-events                       Deletes all L2 events before starting (default: disabled)
  --l2-first-block <number>               The block number to begin syncing events from L2 Farcaster contracts
  --l2-chunk-size <number>                The number of events to fetch from L2 Farcaster contracts at a time
  --l2-chain-id <number>                  The chain ID of the L2 Farcaster contracts are deployed to
  --l2-rent-expiry-override <number>      The storage rent expiry in seconds to use instead of the default 1 year (ONLY FOR TESTS)

Snapshots Options:
  --enable-snapshot-to-s3               Enable daily snapshots to be uploaded to S3. (default: disabled)
  --s3-snapshot-bucket <bucket>         The S3 bucket to upload snapshots to
  --disable-snapshot-sync               Disable syncing from snapshots. (default: enabled)
  --catchup-sync-with-snapshot          Enable catchup sync using S3 snapshot, recommended if Hub is too far behind. (default: disabled)
  --catchup-sync-snapshot-message-limit <number> Difference in message count before triggering snapshot sync. (default: 3_000_000)

Metrics:
  --statsd-metrics-server <host>        The host to send statsd metrics to, eg "127.0.0.1:8125". (default: disabled)

Diagnostics:
  --opt-out-diagnostics [boolean]       Opt-out of sending diagnostics data to the Farcaster Foundation.
                                        Diagnostics are used to troubleshoot user issues and
                                        improve health of the network. (default: disabled)
 --diagnostic-report-url <url>          The URL to send diagnostic reports to. (default: https://report.farcaster.xyz)

Networking Options:
  -a, --allowed-peers <peerIds...>      Only peer with specific peer ids. (default: all peers allowed)
  -b, --bootstrap <peer-multiaddrs...>  Peers to bootstrap gossip and sync from. (default: none)
  -g, --gossip-port <port>              Port to use for gossip (default: 2282)
  -r, --rpc-port <port>                 Port to use for gRPC  (default: 2283)
  -h, --http-api-port <port>            Port to use for HTTP API (default: 2281)
  --http-cors-origin                    CORS origin for HTTP API (default: *)
  --ip <ip-address>                     IP address to listen on (default: "127.0.0.1")
  --announce-ip <ip-address>            Public IP address announced to peers (default: fetched with external service)
  --announce-rpc-port <port>            RPC port announced to peers. Useful if using a reverse proxy (default: gRPC port)
  --announce-server-name <name>         Server name announced to peers, useful if SSL/TLS enabled. (default: "none")
  --admin-server-enabled                Enable the admin server. (default: disabled)
  --admin-server-host <host>            The host the admin server should listen on. (default: '127.0.0.1')
  --http-server-disabled                Set this flag to disable the HTTP server (default: enabled)
  --direct-peers <peer-multiaddrs...>   A list of peers for libp2p to directly peer with (default: [])
  --denied-peers <peerIds...>           Do not peer with specific peer ids. (default: no peers denied)
  --rpc-rate-limit <number>             RPC rate limit for peers specified in rpm. Set to -1 for none. (default: 20k/min)
  --rpc-subscribe-per-ip-limit <number> Maximum RPC subscriptions per IP address (default: 4)

Metrics:
  --statsd-metrics-server <host>        The host to send statsd metrics to, eg "127.0.0.1:8125". (default: disabled)

Debugging Options:
  --profile-sync                        Profile a full hub sync and exit. (default: disabled)
  --rebuild-sync-trie                   Rebuild the sync trie before starting (default: disabled)
  --resync-name-events                  Resync events from the Fname server before starting (default: disabled)
  --chunk-size <number>                 The number of blocks to batch when syncing historical events from Farcaster contracts. (default: 10000)
  --commit-lock-timeout <number>        Rocks DB commit lock timeout in milliseconds (default: 500)
  --commit-lock-max-pending <number>    Rocks DB commit lock max pending jobs (default: 1000)
  --rpc-auth <username:password,...>    Require username-password auth for RPC submit. (default: disabled)
  --disable-console-status              Immediately log to STDOUT, and disable console status and progressbars. (default: disabled)

  -h, --help                            display help for command
  ```

### identity

```
Usage: yarn identity [options] [command]

Create or verify a peerID

Options:
  -h, --help        display help for command

Commands:
  create [options]  Create a new peerId and write it to a file.

                    Note: This command will always overwrite the default PeerId file.
  verify [options]  Verify a peerId file
  help [command]    display help for command
```


### dbreset

```
Usage: yarn dbreset [options]

Completely remove the database

Options:
  --db-name <name>         The name of the RocksDB instance
  -c, --config <filepath>  Path to a config file with options
  -h, --help               display help for command
```

### profile

```
Usage: yarn profile [options]

Profile the db storage for the hubs. Breaks down space used by key.

Options:
  --db-name <name>         The name of the RocksDB instance
  -o <name>                The path to write the output file to
  -c, --config <filepath>  Path to a config file with options
  -h, --help               display help for command
```

### console

```
Usage: hub console [options]

Start a REPL console

Options:
  -s, --server <url>  Farcaster RPC server address:port to connect to (eg. 127.0.0.1:2283) (default: "127.0.0.1:2283")
  --insecure          Allow insecure connections to the RPC server (default: false)
  -h, --help          display help for command
```

### snapshot-url
```
Usage: hub snapshot-url [options]

Print latest snapshot URL and metadata from S3

Options:
  -n --network <network>  ID of the Farcaster Network (default: 1 (mainnet))
  -h, --help              display help for command
```
