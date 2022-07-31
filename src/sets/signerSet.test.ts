import { SignerAdd, SignerRemove, EthereumSigner, Ed25519Signer } from '~/types';
import SignerSet from '~/sets/signerSet';
import { Factories } from '~/factories';
import { generateEd25519Signer, generateEthereumSigner } from '~/utils';
import { ethers } from 'ethers';

const set = new SignerSet();
const vAdds = () => set._getVertexAdds();
const vRems = () => set._getVertexRemoves();
const eAdds = () => set._getEdgeAdds();
const eAddsHashes = () => new Set([...eAdds().values()]);
const eRems = () => set._getEdgeRemoves();
const eRemsHashes = () => new Set([...eRems().values()]);
const custodySigners = () => set._getCustodySigners();
const messages = () => set._getMessages();
const messageHashes = () => new Set([...messages().keys()]);

describe('addCustody', () => {
  let custody1: string;
  let custody2: string;

  beforeAll(async () => {
    const custodyWallet1 = ethers.Wallet.createRandom();
    custody1 = custodyWallet1.address;
    const custodyWallet2 = ethers.Wallet.createRandom();
    custody2 = custodyWallet2.address;
  });

  beforeEach(() => {
    set._reset();
  });

  afterEach(() => {
    expect(messageHashes()).toEqual(new Set());
  });

  test('succeeds with new custody signer', () => {
    expect(set.addCustody(custody1).isOk()).toBe(true);
    expect(custodySigners()).toContain(custody1);
    expect(vAdds().size).toEqual(0);
  });

  test('succeeds with multiple new custody signers', () => {
    expect(set.addCustody(custody1).isOk()).toBe(true);
    expect(set.addCustody(custody2).isOk()).toBe(true);
    expect(custodySigners()).toEqual(new Set([custody1, custody2]));
    expect(vAdds().size).toEqual(0);
  });

  test('succeeds with a duplicate custody signer (idempotent)', () => {
    expect(set.addCustody(custody1).isOk()).toBe(true);
    expect(set.addCustody(custody1).isOk()).toBe(true);
    expect(custodySigners()).toEqual(new Set([custody1]));
  });
});

describe('merge', () => {
  let custodySigner: EthereumSigner;
  let a: Ed25519Signer;
  let addA: SignerAdd;
  let remA: SignerRemove;
  let b: Ed25519Signer;
  let addB: SignerAdd;
  let c: Ed25519Signer;
  let addCToA: SignerAdd;
  let addCToB: SignerAdd;
  let remCFromA: SignerRemove;
  let remCFromB: SignerRemove;
  let d: Ed25519Signer;
  let addDToC: SignerAdd;

  beforeAll(async () => {
    custodySigner = await generateEthereumSigner();
    a = await generateEd25519Signer();
    addA = await Factories.SignerAdd.create({}, { transient: { signer: custodySigner, childSigner: a } });
    remA = await Factories.SignerRemove.create(
      { data: { body: { childKey: a.signerKey } } },
      { transient: { signer: custodySigner } }
    );
    b = await generateEd25519Signer();
    addB = await Factories.SignerAdd.create({}, { transient: { signer: custodySigner, childSigner: b } });
    c = await generateEd25519Signer();
    addCToA = await Factories.SignerAdd.create({}, { transient: { signer: a, childSigner: c } });
    addCToB = await Factories.SignerAdd.create({}, { transient: { signer: b, childSigner: c } });
    remCFromA = await Factories.SignerRemove.create(
      { data: { body: { childKey: c.signerKey } } },
      { transient: { signer: a } }
    );
    remCFromB = await Factories.SignerRemove.create(
      { data: { body: { childKey: c.signerKey } } },
      { transient: { signer: b } }
    );
    d = await generateEd25519Signer();
    addDToC = await Factories.SignerAdd.create({}, { transient: { signer: c, childSigner: d } });
  });

  beforeEach(() => {
    set._reset();
    set.addCustody(custodySigner.signerKey);
  });

  describe('add', () => {
    test('succeeds with a valid SignerAdd message', () => {
      expect(set.merge(addA).isOk()).toEqual(true);
      expect(vAdds()).toEqual(new Set([addA.data.body.childKey]));
      expect(vRems()).toEqual(new Set());
      expect(eAddsHashes()).toEqual(new Set([addA.hash]));
      expect(eRems()).toEqual(new Map());
      expect(messageHashes()).toEqual(new Set([addA.hash]));
    });

    test('succeeds with a duplicate valid SignerAdd message', () => {
      expect(set.merge(addA).isOk()).toBe(true);
      expect(set.merge(addA).isOk()).toBe(true);
      expect(vAdds()).toEqual(new Set([addA.data.body.childKey]));
      expect(vRems()).toEqual(new Set());
      expect(eAddsHashes()).toEqual(new Set([addA.hash]));
      expect(eRems()).toEqual(new Map());
      expect(messageHashes()).toEqual(new Set([addA.hash]));
    });

    test('succeeds when adding a child to a parent', () => {
      expect(set.merge(addA).isOk()).toBe(true);
      expect(set.merge(addCToA).isOk()).toBe(true);
      expect(vAdds()).toEqual(new Set([a.signerKey, c.signerKey]));
      expect(eAddsHashes()).toEqual(new Set([addA.hash, addCToA.hash]));
      expect(messageHashes()).toEqual(new Set([addA.hash, addCToA.hash]));
    });

    describe('when child already exists', () => {
      describe('with different parent', () => {
        beforeEach(() => {
          expect(set.merge(addA).isOk()).toBe(true);
          expect(set.merge(addB).isOk()).toBe(true);
          expect(set.merge(addCToA).isOk()).toBe(true);
          expect(vAdds()).toEqual(new Set([a.signerKey, b.signerKey, c.signerKey]));
          expect(vRems()).toEqual(new Set());
          expect(eAddsHashes()).toEqual(new Set([addA.hash, addB.hash, addCToA.hash]));
          expect(eRemsHashes()).toEqual(new Set());
        });

        test('succeeds with a lower message hash but moves new edge to edgeRemoves', () => {
          const addCToBLowerHash: SignerAdd = { ...addCToB, hash: addCToA.hash.slice(0, -1) };
          expect(set.merge(addCToBLowerHash).isOk()).toBe(true);
          expect(vAdds()).toEqual(new Set([a.signerKey, b.signerKey, c.signerKey]));
          expect(vRems()).toEqual(new Set());
          expect(eAddsHashes()).toEqual(new Set([addA.hash, addB.hash, addCToA.hash]));
          expect(eRemsHashes()).toEqual(new Set([addCToBLowerHash.hash]));
          expect(messageHashes()).toEqual(new Set([addA.hash, addB.hash, addCToA.hash, addCToBLowerHash.hash]));
        });

        test('succeeds with a higher message hash', () => {
          const addCToBHigherHash: SignerAdd = { ...addCToB, hash: addCToA.hash + 'a' };
          expect(set.merge(addCToBHigherHash).isOk()).toBe(true);
          expect(vAdds()).toEqual(new Set([a.signerKey, b.signerKey, c.signerKey]));
          expect(vRems()).toEqual(new Set());
          expect(eAddsHashes()).toEqual(new Set([addA.hash, addB.hash, addCToBHigherHash.hash]));
          expect(eRemsHashes()).toEqual(new Set([addCToA.hash]));
          expect(messageHashes()).toEqual(new Set([addA.hash, addB.hash, addCToA.hash, addCToBHigherHash.hash]));
        });
      });

      describe('with same parent', () => {
        let addCToADuplicate: SignerAdd;

        beforeAll(async () => {
          addCToADuplicate = await Factories.SignerAdd.create({}, { transient: { signer: a, childSigner: c } });
        });

        beforeEach(() => {
          expect(set.merge(addA).isOk()).toBe(true);
          expect(set.merge(addCToA).isOk()).toBe(true);
          expect(vAdds()).toEqual(new Set([a.signerKey, c.signerKey]));
          expect(vRems()).toEqual(new Set());
          expect(eAddsHashes()).toEqual(new Set([addA.hash, addCToA.hash]));
          expect(eRemsHashes()).toEqual(new Set());
        });

        test('succeeds with a lower message hash but does not update edgeAdds', () => {
          const addCToADuplicateLowerHash: SignerAdd = { ...addCToADuplicate, hash: addCToA.hash.slice(0, -1) };
          expect(set.merge(addCToADuplicateLowerHash).isOk()).toBe(true);
          expect(vAdds()).toEqual(new Set([a.signerKey, c.signerKey]));
          expect(vRems()).toEqual(new Set());
          expect(eAddsHashes()).toEqual(new Set([addA.hash, addCToA.hash]));
          expect(eRemsHashes()).toEqual(new Set());
          expect(messageHashes()).toEqual(new Set([addA.hash, addCToA.hash, addCToADuplicateLowerHash.hash]));
        });

        test('succeeds with a higher message hash', () => {
          const addCToADuplicateHigherHash: SignerAdd = { ...addCToADuplicate, hash: addCToA.hash + 'z' };
          expect(set.merge(addCToADuplicateHigherHash).isOk()).toBe(true);
          expect(vAdds()).toEqual(new Set([a.signerKey, c.signerKey]));
          expect(vRems()).toEqual(new Set());
          expect(eAddsHashes()).toEqual(new Set([addA.hash, addCToADuplicateHigherHash.hash]));
          expect(eRemsHashes()).toEqual(new Set());
          expect(messageHashes()).toEqual(new Set([addA.hash, addCToA.hash, addCToADuplicateHigherHash.hash]));
        });
      });
    });

    test('fails when parent does not exist', () => {
      expect(vAdds().size).toEqual(0);
      expect(set.merge(addCToA).isOk()).toBe(false);
      expect(vAdds()).toEqual(new Set());
      expect(vRems()).toEqual(new Set());
      expect(eAddsHashes()).toEqual(new Set());
      expect(eRemsHashes()).toEqual(new Set());
      expect(messageHashes()).toEqual(new Set());
    });

    test('succeeds when child has already been deleted by another parent and moves new edge to edgeRemoves', () => {
      const messages = [addA, addCToA, addB, remCFromA, addCToB];
      for (const msg of messages) {
        expect(set.merge(msg).isOk()).toBe(true);
      }
      expect(vAdds()).toEqual(new Set([a.signerKey, b.signerKey]));
      expect(vRems()).toEqual(new Set([c.signerKey]));
      expect(eAddsHashes()).toEqual(new Set([addA.hash, addB.hash]));
      expect(eRemsHashes()).toEqual(new Set([addCToA.hash, addCToB.hash]));
      expect(messageHashes()).toEqual(new Set(messages.map((msg) => msg.hash)));
    });

    describe('cycle prevention', () => {
      let addCHigherHash: SignerAdd;
      let addAToCHigherHash: SignerAdd;

      beforeAll(async () => {
        addCHigherHash = await Factories.SignerAdd.create({}, { transient: { signer: custodySigner, childSigner: c } });
        addCHigherHash.hash = addCToA.hash + 'a';
        addAToCHigherHash = await Factories.SignerAdd.create({}, { transient: { signer: c, childSigner: a } });
        addAToCHigherHash.hash = addA.hash + 'a';
      });

      // When all messages are accepted, the set converges
      afterEach(() => {
        expect(vAdds()).toEqual(new Set([a.signerKey, c.signerKey]));
        expect(vRems()).toEqual(new Set());
        expect(eAddsHashes()).toEqual(new Set([addAToCHigherHash.hash, addCHigherHash.hash]));
        expect(eRemsHashes()).toEqual(new Set([addA.hash, addCToA.hash]));
        expect(messageHashes()).toEqual(
          new Set([addA.hash, addCToA.hash, addAToCHigherHash.hash, addCHigherHash.hash])
        );
      });

      test('succeeds after retry', () => {
        expect(set.merge(addA).isOk()).toBe(true);
        expect(set.merge(addCToA).isOk()).toBe(true);
        expect(set.merge(addAToCHigherHash).isOk()).toBe(false);
        expect(messageHashes()).not.toContain(addAToCHigherHash.hash);
        expect(set.merge(addCHigherHash).isOk()).toBe(true);
        expect(set.merge(addAToCHigherHash).isOk()).toBe(true); // Retry
      });

      test('succeeds when new edges do not create a cycle', () => {
        expect(set.merge(addA).isOk()).toBe(true);
        expect(set.merge(addCHigherHash).isOk()).toBe(true);
        expect(set.merge(addCToA).isOk()).toBe(true);
        expect(set.merge(addAToCHigherHash).isOk()).toBe(true);
      });

      test('succeeds when edge that would create a cycle has lower hash', () => {
        expect(set.merge(addCHigherHash).isOk()).toBe(true);
        expect(set.merge(addAToCHigherHash).isOk()).toBe(true);
        expect(set.merge(addCToA).isOk()).toBe(true); // lower hash prevents cycle in edgeAdds
        expect(set.merge(addA).isOk()).toBe(true);
      });
    });

    test('succeeds when creating a cycle in edgeRemoves graph', async () => {
      const addCToBHigherHash: SignerAdd = { ...addCToB, hash: addCToA.hash + 'a' };
      const addAToCHigherHash = await Factories.SignerAdd.create({}, { transient: { signer: c, childSigner: a } });
      addAToCHigherHash.hash = addA.hash + 'a';
      const messages = [addA, addB, addCToA, addCToBHigherHash, addAToCHigherHash];
      for (const msg of messages) {
        expect(set.merge(msg).isOk()).toBe(true);
      }
      expect(vAdds()).toEqual(new Set([a.signerKey, b.signerKey, c.signerKey]));
      expect(vRems()).toEqual(new Set());
      expect(eAddsHashes()).toEqual(new Set([addB.hash, addAToCHigherHash.hash, addCToBHigherHash.hash]));
      expect(eRemsHashes()).toEqual(new Set([addA.hash, addCToA.hash]));
      expect(messageHashes()).toEqual(new Set(messages.map((msg) => msg.hash)));
    });

    describe('when adding a child to subtree that is already removed', () => {
      test('succeeds with new child', () => {
        const messages = [addA, addCToA, remA, addDToC];
        for (const msg of messages) {
          expect(set.merge(msg).isOk()).toBe(true);
        }
        expect(vAdds()).toEqual(new Set([]));
        expect(vRems()).toEqual(new Set([a.signerKey, c.signerKey, d.signerKey]));
        expect(eAddsHashes()).toEqual(new Set([]));
        expect(eRemsHashes()).toEqual(new Set([addA.hash, addCToA.hash, addDToC.hash]));
        expect(messageHashes()).toEqual(new Set(messages.map((msg) => msg.hash)));
      });

      test('succeeds when child already exists in tree', () => {
        const messages = [addB, addCToB, addA, remA, addCToA];
        for (const msg of messages) {
          expect(set.merge(msg).isOk()).toBe(true);
        }
        expect(vAdds()).toEqual(new Set([b.signerKey]));
        expect(vRems()).toEqual(new Set([a.signerKey, c.signerKey]));
        expect(eAddsHashes()).toEqual(new Set([addB.hash]));
        expect(eRemsHashes()).toEqual(new Set([addCToB.hash, addA.hash, addCToA.hash]));
        expect(messageHashes()).toEqual(new Set(messages.map((msg) => msg.hash)));
      });
    });

    describe('when child is added by different parents and then deleted by both parents', () => {
      afterEach(() => {
        expect(vAdds()).toEqual(new Set([a.signerKey, b.signerKey]));
        expect(vRems()).toEqual(new Set([c.signerKey]));
        expect(eAddsHashes()).toEqual(new Set([addA.hash, addB.hash]));
        expect(eRemsHashes()).toEqual(new Set([addCToA.hash, addCToB.hash]));
      });

      test('succeeds when edges are both added and then both removed', () => {
        const messages = [addA, addB, addCToA, addCToB, remCFromA, remCFromB];
        for (const msg of messages) {
          expect(set.merge(msg).isOk()).toBe(true);
        }
        expect(messageHashes()).toEqual(new Set(messages.map((msg) => msg.hash)));
      });

      test('succeeds when edges are added and removed sequentially', () => {
        const messages = [addA, addB, addCToA, remCFromA, addCToB, remCFromB];
        for (const msg of messages) {
          expect(set.merge(msg).isOk()).toBe(true);
        }
        expect(messageHashes()).toEqual(new Set(messages.map((msg) => msg.hash)));
      });
    });
  });

  describe('remove', () => {
    test('succeeds with a valid SignerRemove message', () => {
      expect(set.merge(addA).isOk()).toBe(true);
      expect(set.merge(remA).isOk()).toBe(true);
      expect(vAdds()).toEqual(new Set([]));
      expect(vRems()).toEqual(new Set([a.signerKey]));
      expect(eAddsHashes()).toEqual(new Set([]));
      expect(eRemsHashes()).toEqual(new Set([addA.hash]));
      expect(messageHashes()).toEqual(new Set([addA.hash, remA.hash]));
    });

    test("fails when child hasn't been added yet", () => {
      expect(set.merge(remA).isOk()).toBe(false);
      expect(vAdds()).toEqual(new Set());
      expect(vRems()).toEqual(new Set());
      expect(eAddsHashes()).toEqual(new Set());
      expect(eRemsHashes()).toEqual(new Set());
      expect(messageHashes()).toEqual(new Set());
    });

    test('succeeds and removes subtree', () => {
      expect(set.merge(addA).isOk()).toBe(true);
      expect(set.merge(addCToA).isOk()).toBe(true);
      expect(set.merge(remA).isOk()).toBe(true);
      expect(vAdds()).toEqual(new Set([]));
      expect(vRems()).toEqual(new Set([a.signerKey, c.signerKey]));
      expect(eAddsHashes()).toEqual(new Set([]));
      expect(eRemsHashes()).toEqual(new Set([addA.hash, addCToA.hash]));
      expect(messageHashes()).toEqual(new Set([addA.hash, remA.hash, addCToA.hash]));
    });

    test("fails when child doesn't belong to parent", async () => {
      expect(set.merge(addA).isOk()).toBe(true);
      expect(set.merge(addCToA).isOk()).toBe(true);
      const remC = await Factories.SignerRemove.create(
        { data: { body: { childKey: c.signerKey } } },
        { transient: { signer: custodySigner } }
      );
      expect(set.merge(remC).isOk()).toBe(false);
      expect(vAdds()).toEqual(new Set([a.signerKey, c.signerKey]));
      expect(vRems()).toEqual(new Set());
      expect(eAddsHashes()).toEqual(new Set([addA.hash, addCToA.hash]));
      expect(eRemsHashes()).toEqual(new Set());
      expect(messageHashes()).toEqual(new Set([addA.hash, addCToA.hash]));
    });

    test('succeeds when child belongs to parent', () => {
      expect(set.merge(addA).isOk()).toBe(true);
      expect(set.merge(addCToA).isOk()).toBe(true);
      expect(set.merge(remCFromA).isOk()).toBe(true);
      expect(vAdds()).toEqual(new Set([a.signerKey]));
      expect(vRems()).toEqual(new Set([c.signerKey]));
      expect(eAddsHashes()).toEqual(new Set([addA.hash]));
      expect(eRemsHashes()).toEqual(new Set([addCToA.hash]));
      expect(messageHashes()).toEqual(new Set([addA.hash, addCToA.hash, remCFromA.hash]));
    });

    test('succeeds with duplicate signer remove message', () => {
      expect(set.merge(addA).isOk()).toBe(true);
      expect(set.merge(remA).isOk()).toBe(true);
      expect(set.merge(remA).isOk()).toBe(true);
      expect(vAdds()).toEqual(new Set([]));
      expect(vRems()).toEqual(new Set([a.signerKey]));
      expect(eAddsHashes()).toEqual(new Set([]));
      expect(eRemsHashes()).toEqual(new Set([addA.hash]));
      expect(messageHashes()).toEqual(new Set([addA.hash, remA.hash]));
    });

    test('a child is removed after its parent has already been removed', () => {
      const messages = [addA, addCToA, remA, remCFromA];
      for (const msg of messages) {
        expect(set.merge(msg).isOk()).toBe(true);
      }
      expect(vAdds()).toEqual(new Set([]));
      expect(vRems()).toEqual(new Set([a.signerKey, c.signerKey]));
      expect(eAddsHashes()).toEqual(new Set([]));
      expect(eRemsHashes()).toEqual(new Set([addA.hash, addCToA.hash]));
      expect(messageHashes()).toEqual(new Set(messages.map((msg) => msg.hash)));
    });
  });
});
