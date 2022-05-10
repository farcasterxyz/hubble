import { Cast, Root, Message, RootMessageBody, Reaction } from '~/types';
import Engine from '~/engine';
import { Result } from 'neverthrow';

/** The Node brokers messages to clients and peers and passes new messages into the Engine for resolution  */
class FCNode {
  public static instanceNames = ['Cook', 'Friar', 'Knight', 'Miller', 'Squire'] as const;
  // TODO: Replace with usernames fetched from the on-chain Registry.
  public static usernames = ['alice', 'bob'];

  name: InstanceName;
  peers?: NodeDirectory;
  engine: Engine;

  constructor(name: InstanceName) {
    this.name = name;
    this.engine = new Engine();
  }

  setPeers(peers: NodeDirectory): void {
    this.peers = new Map(peers);
    this.peers.delete(this.name); // remove self from list of peers
  }

  /** Sync messages with all peers */
  async sync(): Promise<void> {
    this.peers?.forEach((peer) => this.syncWithPeer(peer));
  }

  /** Sync messages with a specific peer */
  syncWithPeer(peer: FCNode): void {
    FCNode.usernames.forEach((username) => {
      this.syncUserWithPeer(username, peer);
    });
  }

  /** Sync messages for a specific user with a specific peer */
  syncUserWithPeer(username: string, peer: FCNode): void {
    const selfRoot = this.getRoot(username);
    const peerRoot = peer.getRoot(username);
    if (peerRoot) {
      // 1. Compare roots and add the peer's root if newer.
      if (!selfRoot || selfRoot.data.rootBlock <= peerRoot.data.rootBlock) {
        this.addRoot(peerRoot);
      }

      // 2. Compare CastAdd messages and ingest new ones.
      const selfCastAddHashes = this.getCastAddsHashes(username);
      const peerCastAddHashes = peer.getCastAddsHashes(username);
      const missingCastAddsHashes = peerCastAddHashes.filter((h) => !selfCastAddHashes.includes(h));
      peer.getCasts(username, missingCastAddsHashes).map((message) => this.addCast(message));

      // 3. Compare CastDelete messages and ingest new ones.
      const selfCastDeleteHashes = this.getCastDeletesHashes(username);
      const peerCastDeleteHashes = peer.getCastDeletesHashes(username);
      const missingCastDeleteHashes = peerCastDeleteHashes.filter((h) => !selfCastDeleteHashes.includes(h));
      peer.getCasts(username, missingCastDeleteHashes).map((message) => this.addCast(message));

      // 4. Compare Reactions and ingest the new ones.
      const selfReactionHashes = this.getReactionHashes(username);
      const peerReactionHashes = peer.getReactionHashes(username);
      const missingReactionHashes = peerReactionHashes.filter((h) => !selfReactionHashes.includes(h));
      peer.getReactions(username, missingReactionHashes).map((reaction) => this.addReaction(reaction));
    }
  }

  /**
   * P2P API's
   *
   * These API's should be called by peer nodes during the sync process. They should never be called
   * by clients, because they are less strict and this may cause more conflicts.
   */

  /** Get the Root Message for a username */
  getRoot(username: string): Message<RootMessageBody> | undefined {
    return this.engine.getRoot(username);
  }

  /** Get casts by hash, or corresponding delete message */
  getCasts(username: string, hashes: string[]): Message<any>[] {
    const messages = [];

    for (const hash of hashes) {
      const message = this.engine.getCast(username, hash);
      if (message) {
        messages.push(message);
      }
    }

    return messages;
  }

  getCastAdds(username: string): Cast[] {
    return this.engine.getCastAdds(username);
  }

  getCastDeletes(username: string): Cast[] {
    return this.engine.getCastAdds(username);
  }

  getCastAddsHashes(username: string): string[] {
    return this.engine.getCastAddsHashes(username);
  }

  getCastDeletesHashes(username: string): string[] {
    return this.engine.getCastDeletesHashes(username);
  }

  /** Get reactions by hash */
  getReactions(username: string, hashes: string[]): Message<any>[] {
    const reactions = [];

    for (const hash of hashes) {
      const message = this.engine.getReaction(username, hash);
      if (message) {
        reactions.push(message);
      }
    }

    return reactions;
  }

  getReactionHashes(username: string): string[] {
    return this.engine.getReactionHashes(username);
  }

  /**
   * Client API
   *
   * These API's should be called by clients to interact with the node. They should never be called
   * by peers, because they are less strict and this may cause divergent network states.
   */

  addRoot(root: Root): Result<void, string> {
    return this.engine.addRoot(root);
  }

  addCast(cast: Cast): Result<void, string> {
    return this.engine.addCast(cast);
  }

  addReaction(reaction: Reaction): Result<void, string> {
    return this.engine.addReaction(reaction);
  }
}

export type NodeDirectory = Map<InstanceName, FCNode>;
export type InstanceName = typeof FCNode.instanceNames[number];

export default FCNode;
