import { randomBytes } from 'crypto';
import { bytesToHexString } from '../bytes';
import { eip712 } from '../crypto';
import { Factories } from '../factories';
import { VerificationEthAddressClaim, makeVerificationEthAddressClaim } from '../verifications';
import { ViemLocalEip712Signer } from './ViemLocalEip712Signer';
import { FarcasterNetwork } from '../protobufs';
import { Wallet } from 'ethers5';
import { ethersWalletToAccount } from 'viem/ethers';
import { blake3 } from '@noble/hashes/blake3';
// import { privateKeyToAccount } from 'viem/accounts';

describe('ViemLocalEip712Signer', () => {
  describe('with ethers account', () => {
    let signer: ViemLocalEip712Signer;
    let signerKey: Uint8Array;

    beforeAll(async () => {
      const ethersAccount = ethersWalletToAccount(
        new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
      );
      signer = new ViemLocalEip712Signer(ethersAccount);
      signerKey = (await signer.getSignerKey())._unsafeUnwrap();
    });

    describe('instanceMethods', () => {
      describe('signMessageHash', () => {
        test('generates valid signature', async () => {
          const bytes = randomBytes(32);
          const hash = blake3(bytes, { dkLen: 20 });
          const signature = (await signer.signMessageHash(hash))._unsafeUnwrap();
          const recoveredAddress = (await eip712.verifyMessageHashSignature(hash, signature))._unsafeUnwrap();
          expect(recoveredAddress).toEqual(signerKey);
        });
      });

      describe('signVerificationEthAddressClaim', () => {
        let claim: VerificationEthAddressClaim;
        let signature: Uint8Array;

        beforeAll(async () => {
          claim = makeVerificationEthAddressClaim(
            Factories.Fid.build(),
            signerKey,
            FarcasterNetwork.TESTNET,
            Factories.BlockHash.build()
          )._unsafeUnwrap();
          signature = (await signer.signVerificationEthAddressClaim(claim))._unsafeUnwrap();
        });

        test('succeeds', async () => {
          expect(signature).toBeTruthy();
          const recoveredAddress = eip712.verifyVerificationEthAddressClaimSignature(claim, signature)._unsafeUnwrap();
          expect(recoveredAddress).toEqual(signerKey);
        });

        test('succeeds when encoding twice', async () => {
          const claim2: VerificationEthAddressClaim = { ...claim };
          const signature2 = (await signer.signVerificationEthAddressClaim(claim2))._unsafeUnwrap();
          expect(signature2).toEqual(signature);
          expect(bytesToHexString(signature2)).toEqual(bytesToHexString(signature));
        });
      });
    });
  });

  // describe('with private key account', () => {
  //   let signer: ViemLocalEip712Signer;
  //   let signerKey: Uint8Array;

  //   beforeAll(async () => {
  //     const privateKeyAccount = privateKeyToAccount(
  //       '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  //     );
  //     signer = new ViemLocalEip712Signer(privateKeyAccount);
  //     signerKey = (await signer.getSignerKey())._unsafeUnwrap();
  //   });

  //   describe('instanceMethods', () => {
  //     describe('signMessageHash', () => {
  //       test('generates valid signature', async () => {
  //         const bytes = randomBytes(32);
  //         const hash = blake3(bytes, { dkLen: 20 });
  //         const signature = (await signer.signMessageHash(hash))._unsafeUnwrap();
  //         const recoveredAddress = (await eip712.verifyMessageHashSignature(hash, signature))._unsafeUnwrap();
  //         expect(recoveredAddress).toEqual(signerKey);
  //       });
  //     });

  //     describe('signVerificationEthAddressClaim', () => {
  //       let claim: VerificationEthAddressClaim;
  //       let signature: Uint8Array;

  //       beforeAll(async () => {
  //         claim = makeVerificationEthAddressClaim(
  //           Factories.Fid.build(),
  //           signerKey,
  //           FarcasterNetwork.TESTNET,
  //           Factories.BlockHash.build()
  //         )._unsafeUnwrap();
  //         signature = (await signer.signVerificationEthAddressClaim(claim))._unsafeUnwrap();
  //       });

  //       test('succeeds', async () => {
  //         expect(signature).toBeTruthy();
  //         const recoveredAddress = eip712.verifyVerificationEthAddressClaimSignature(claim, signature)._unsafeUnwrap();
  //         expect(recoveredAddress).toEqual(signerKey);
  //       });

  //       test('succeeds when encoding twice', async () => {
  //         const claim2: VerificationEthAddressClaim = { ...claim };
  //         const signature2 = (await signer.signVerificationEthAddressClaim(claim2))._unsafeUnwrap();
  //         expect(signature2).toEqual(signature);
  //         expect(bytesToHexString(signature2)).toEqual(bytesToHexString(signature));
  //       });
  //     });
  //   });
  // });
});
