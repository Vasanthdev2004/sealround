//! Per-sale X25519 keys, derived from the enclave's master secret.
//!
//! ```text
//! sk = HKDF-SHA256(ikm = master, salt = "fairground/sealer/v1",
//!                  info = "sale-key" || 0x00 || contract_id || 0x00 || sale_id)   32 bytes
//! pk = X25519(sk, 9)
//! ```
//!
//! Only the master secret has to be stored (OutLayer generates and keeps it in
//! its TEE keystore); every sale's key can be rebuilt from it at any time.

use core::fmt;

use crypto_box::{PublicKey, SecretKey};
use curve25519_dalek::MontgomeryPoint;
use fairground_clearing::hash::to_hex;
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

/// HKDF salt. Versions the derivation, so a future scheme gets unrelated keys.
pub const KEY_SALT: &[u8] = b"fairground/sealer/v1";
/// HKDF info prefix. The contract id and the sale id follow, each after a 0x00 byte.
pub const KEY_INFO_PREFIX: &[u8] = b"sale-key";

/// One sale's sealing keypair. Bidders seal to [`SaleKeypair::public_key`];
/// only the holder of the master secret can rebuild the secret half.
#[derive(Clone)]
pub struct SaleKeypair {
    secret: SecretKey,
    public: PublicKey,
}

impl SaleKeypair {
    /// The keypair of `sale_id` on the Fairground contract `contract_id`.
    ///
    /// The ids are separated by 0x00, which neither a NEAR account id nor a
    /// sale id can contain, so distinct (contract, sale) pairs never share a key.
    pub fn derive(master: &[u8; 32], contract_id: &str, sale_id: &str) -> Self {
        let hkdf = Hkdf::<Sha256>::new(Some(KEY_SALT), master);
        let mut secret = Zeroizing::new([0u8; 32]);
        hkdf.expand_multi_info(
            &[
                KEY_INFO_PREFIX,
                &[0],
                contract_id.as_bytes(),
                &[0],
                sale_id.as_bytes(),
            ],
            secret.as_mut_slice(),
        )
        .expect("32 bytes is far below HKDF-SHA256's 8160-byte output limit");
        let secret = SecretKey::from_bytes(*secret);
        let public = secret.public_key();
        Self { secret, public }
    }

    /// The X25519 public key bidders seal to.
    pub fn public_key(&self) -> [u8; 32] {
        self.public.to_bytes()
    }

    /// [`Self::public_key`] as lowercase hex, as published on-chain.
    pub fn public_key_hex(&self) -> String {
        to_hex(self.public.as_bytes())
    }

    /// Opens a libsodium sealed box (`crypto_box_seal_open`): returns the
    /// plaintext, or `None` if the box is malformed or was not sealed to this key.
    pub fn open(&self, sealed: &[u8]) -> Option<Vec<u8>> {
        let ephemeral = sealed.first_chunk::<32>()?;
        if !in_prime_order_subgroup(ephemeral) {
            return None;
        }
        self.secret.unseal(sealed).ok()
    }
}

/// Whether an X25519 public key is a point of the prime-order subgroup.
///
/// `crypto_box_seal` always makes its ephemeral key that way. Refusing any
/// other key keeps `crypto_box`'s Diffie-Hellman (which reduces the secret
/// scalar mod the group order) equal to RFC 7748 X25519, and stops a crafted
/// small-order key from leaking low bits of the sale's secret key through
/// which boxes open. The check uses only public data.
fn in_prime_order_subgroup(key: &[u8; 32]) -> bool {
    MontgomeryPoint(*key)
        .to_edwards(0)
        .is_some_and(|point| point.is_torsion_free())
}

impl fmt::Debug for SaleKeypair {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SaleKeypair")
            .field("public", &self.public_key_hex())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use curve25519_dalek::constants::{EIGHT_TORSION, X25519_BASEPOINT};
    use curve25519_dalek::traits::IsIdentity;

    use super::*;

    #[test]
    fn honest_keys_are_in_the_subgroup_and_torsion_is_not() {
        let keypair = SaleKeypair::derive(&[1; 32], "fairground.testnet", "fairt");
        assert!(in_prime_order_subgroup(&keypair.public_key()));
        assert!(in_prime_order_subgroup(X25519_BASEPOINT.as_bytes()));
        for torsion in EIGHT_TORSION {
            let small = torsion.to_montgomery().to_bytes();
            assert!(!in_prime_order_subgroup(&small));
            let mixed = (torsion + X25519_BASEPOINT.to_edwards(0).unwrap()).to_montgomery();
            if torsion.is_identity() {
                assert!(in_prime_order_subgroup(mixed.as_bytes()));
            } else {
                assert!(!in_prime_order_subgroup(mixed.as_bytes()));
            }
        }
        // u = -1 is on the twist, so it has no Edwards form.
        let mut minus_one = [0xff; 32];
        minus_one[0] = 0xec;
        minus_one[31] = 0x7f;
        assert!(!in_prime_order_subgroup(&minus_one));
    }

    /// A box built the way `crypto_box` unseals, but with a torsion component in
    /// the ephemeral key: `crypto_box` alone would open it, `open` refuses it.
    #[test]
    fn boxes_with_a_torsioned_ephemeral_key_are_refused() {
        use blake2::{Blake2b, Digest, digest::consts::U24};
        use crypto_box::{SalsaBox, aead::Aead};

        let keypair = SaleKeypair::derive(&[9; 32], "fairground.testnet", "fairt");
        let honest = X25519_BASEPOINT.to_edwards(0).unwrap() * curve25519_dalek::Scalar::from(77u8);
        for ephemeral in [
            EIGHT_TORSION[1],
            EIGHT_TORSION[3],
            honest + EIGHT_TORSION[2],
        ] {
            let ephemeral = ephemeral.to_montgomery().to_bytes();
            let nonce = Blake2b::<U24>::new()
                .chain_update(ephemeral)
                .chain_update(keypair.public_key())
                .finalize();
            let salsa = SalsaBox::new(&PublicKey::from_bytes(ephemeral), &keypair.secret);
            let mut sealed = ephemeral.to_vec();
            sealed.extend(salsa.encrypt(&nonce, b"{}".as_slice()).unwrap());
            assert_eq!(keypair.secret.unseal(&sealed).unwrap(), b"{}");
            assert_eq!(keypair.open(&sealed), None);
        }
    }

    #[test]
    fn debug_never_prints_the_secret() {
        let keypair = SaleKeypair::derive(&[7; 32], "c.testnet", "s");
        let text = format!("{keypair:?}");
        assert!(text.contains(&keypair.public_key_hex()));
        assert!(!text.contains("secret"));
    }
}
