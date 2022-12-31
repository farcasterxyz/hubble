import * as flatbuffers from '@hub/flatbuffers';
import { blake3 } from '@noble/hashes/blake3';
import { arrayify, hexlify } from 'ethers/lib/utils';
import { generateEd25519KeyPair, generateEthereumSigner } from '~/utils/crypto';
import { Ed25519MessageSigner, EthersMessageSigner, IMessageSigner } from '../messageSigner';
import { EthereumSigner, KeyPair, SignerAddModel } from '../models/types';
import { numberToLittleEndianBytes } from '../utils/bytes';
import { verifyMessageHashSignature } from '../utils/eip712';
import MessageBuilder from './messageBuilder';

describe('MessageBuilder', () => {
  let builder: MessageBuilder;
  let keyPair: KeyPair;
  let ethereumSigner: EthereumSigner;
  let ethersSigner: EthersMessageSigner;
  let edDSASigner: IMessageSigner;

  const fid = 24;

  beforeAll(async () => {
    keyPair = await generateEd25519KeyPair();
    ethereumSigner = await generateEthereumSigner();
    edDSASigner = new Ed25519MessageSigner(keyPair.privateKey, hexlify(keyPair.publicKey));
    ethersSigner = new EthersMessageSigner(ethereumSigner.wallet);
    builder = new MessageBuilder({ fid, eip712Signer: ethersSigner, ed2559Signer: edDSASigner });
  });

  describe('static methods', () => {
    describe('constructor', () => {
      test('fails with invalid fid', async () => {
        expect(
          () =>
            new MessageBuilder({
              fid: -1,
              eip712Signer: ethersSigner,
            })
        ).toThrow();
      });
    });
  });

  describe('instance methods', () => {
    describe('makeSignerAdd', () => {
      let newSigner: KeyPair;
      let message: SignerAddModel;
      let messageBody: flatbuffers.SignerBody;

      beforeAll(async () => {
        newSigner = await generateEd25519KeyPair();
        message = await builder.makeSignerAdd({
          publicKey: hexlify(newSigner.publicKey),
        });
        messageBody = message.body();
      });

      test('generates signer', async () => {
        expect(message.signer()).toEqual(arrayify(ethereumSigner.wallet.address));
      });

      test('generates hash', async () => {
        expect(message.hash()).toEqual(blake3(message.dataBytes(), { dkLen: 16 }));
      });

      test('generates hash scheme', async () => {
        expect(message.hashScheme()).toEqual(flatbuffers.HashScheme.Blake3);
      });

      test('generates signature', async () => {
        const recoveredAddress = verifyMessageHashSignature(message.hash(), message.signature());
        expect(recoveredAddress).toEqual(arrayify(ethereumSigner.wallet.address));
      });

      test('generates signature scheme', async () => {
        expect(message.signatureScheme()).toEqual(flatbuffers.SignatureScheme.Eip712);
      });

      describe('data', () => {
        test('generates network', async () => {
          expect(message.data.network()).toEqual(flatbuffers.FarcasterNetwork.Mainnet);
        });

        test('generates fid', async () => {
          expect(message.data.fidArray()).toEqual(numberToLittleEndianBytes(fid)._unsafeUnwrap());
        });

        test('generates type', () => {
          expect(message.data.type()).toEqual(flatbuffers.MessageType.SignerAdd);
        });

        test('generates body type', () => {
          expect(message.data.bodyType()).toEqual(flatbuffers.MessageBody.SignerBody);
        });

        describe('body', () => {
          test('generates signer', () => {
            expect(messageBody.signerArray()).toEqual(newSigner.publicKey);
          });
        });
      });
    });
  });
});
