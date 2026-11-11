//! `a * b / d` on u128 values with a 256-bit intermediate.
//!
//! Spends, prices and token amounts are u128, but their products
//! (`spend * ONE`, `tokens * price`, `weight * amount`) can need up to 256 bits.
//! These helpers compute the quotient exactly and return `None`, never panic,
//! when the divisor is zero or the quotient does not fit in u128.

use ethnum::U256;

/// `floor(a * b / d)`, or `None` if `d == 0` or the quotient exceeds `u128::MAX`.
pub fn mul_div_floor(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    match a.checked_mul(b) {
        Some(product) => Some(product / d),
        None => narrow(wide_mul(a, b) / U256::new(d)),
    }
}

/// `ceil(a * b / d)`, or `None` if `d == 0` or the quotient exceeds `u128::MAX`.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    match a.checked_mul(b) {
        // The quotient only rounds up when there is a remainder, so it stays <= u128::MAX.
        Some(product) => Some(product.div_ceil(d)),
        None => {
            let (quotient, remainder) = wide_mul(a, b).checked_div_rem(U256::new(d))?;
            let quotient = narrow(quotient)?;
            if remainder == U256::ZERO {
                Some(quotient)
            } else {
                quotient.checked_add(1)
            }
        }
    }
}

/// `floor(a * b / d)` for a divisor that may itself exceed u128 (a sum of u128 weights).
pub(crate) fn mul_div_floor_wide(a: u128, b: u128, d: U256) -> Option<u128> {
    match narrow(d) {
        Some(d) => mul_div_floor(a, b, d),
        None => narrow(wide_mul(a, b).checked_div(d)?),
    }
}

/// The sum, or `None` if it exceeds u128.
pub(crate) fn checked_sum(values: impl IntoIterator<Item = u128>) -> Option<u128> {
    values.into_iter().try_fold(0u128, u128::checked_add)
}

/// Exact sum of u128 values. A slice holds fewer than 2^64 items, so the sum
/// stays below 2^192 and the wrapping add never wraps.
pub(crate) fn wide_sum(values: &[u128]) -> U256 {
    values
        .iter()
        .fold(U256::ZERO, |sum, &v| sum.wrapping_add(U256::new(v)))
}

/// The full product. `(2^128 - 1)^2 < 2^256`, so the wrapping multiply never wraps.
fn wide_mul(a: u128, b: u128) -> U256 {
    U256::new(a).wrapping_mul(U256::new(b))
}

/// The value as u128 if it fits.
pub(crate) fn narrow(x: U256) -> Option<u128> {
    let (high, low) = x.into_words();
    (high == 0).then_some(low)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX: u128 = u128::MAX;

    /// Checks `q` against the definition of floor division using only 256-bit
    /// multiply, add and compare (not the division under test).
    fn assert_floor(a: u128, b: u128, d: u128, q: Option<u128>) {
        let product = wide_mul(a, b);
        match q {
            Some(q) => {
                let low = U256::new(q) * U256::new(d);
                assert!(low <= product, "floor too high: {a}*{b}/{d} = {q}");
                assert!(
                    product - low < U256::new(d),
                    "floor too low: {a}*{b}/{d} = {q}"
                );
            }
            // No quotient: d == 0, or a*b >= d * 2^128.
            None => assert!(
                d == 0 || (U256::new(d) << 128) <= product,
                "spurious None: {a}*{b}/{d}"
            ),
        }
    }

    fn assert_ceil(a: u128, b: u128, d: u128, floor: Option<u128>, ceil: Option<u128>) {
        if d == 0 {
            assert_eq!(ceil, None);
            return;
        }
        let exact = floor.is_some_and(|q| U256::new(q) * U256::new(d) == wide_mul(a, b));
        match floor {
            Some(q) if exact => assert_eq!(ceil, Some(q)),
            Some(q) => assert_eq!(ceil, q.checked_add(1)),
            None => assert_eq!(ceil, None),
        }
    }

    fn check(a: u128, b: u128, d: u128) {
        let floor = mul_div_floor(a, b, d);
        assert_floor(a, b, d, floor);
        assert_ceil(a, b, d, floor, mul_div_ceil(a, b, d));
        assert_eq!(mul_div_floor_wide(a, b, U256::new(d)), floor);
    }

    /// SplitMix64: a tiny deterministic generator for test inputs.
    struct SplitMix(u64);
    impl SplitMix {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            z ^ (z >> 31)
        }
        /// A value with a random bit length, so small and huge values both show up.
        fn value(&mut self) -> u128 {
            let raw = (u128::from(self.next()) << 64) | u128::from(self.next());
            let bits = (self.next() % 129) as u32;
            if bits == 0 { 0 } else { raw >> (128 - bits) }
        }
    }

    #[test]
    fn exhaustive_small_values() {
        for a in 0..=40u128 {
            for b in 0..=40u128 {
                for d in 0..=40u128 {
                    check(a, b, d);
                }
            }
        }
    }

    #[test]
    fn edges_near_u128_max() {
        let edges = [
            0,
            1,
            2,
            3,
            10,
            1 << 64,
            (1 << 64) - 1,
            1 << 127,
            MAX / 2,
            MAX - 1,
            MAX,
        ];
        for &a in &edges {
            for &b in &edges {
                for &d in &edges {
                    check(a, b, d);
                }
            }
        }
        assert_eq!(mul_div_floor(MAX, MAX, MAX), Some(MAX));
        assert_eq!(mul_div_ceil(MAX, MAX, MAX), Some(MAX));
        assert_eq!(mul_div_floor(MAX, 2, 2), Some(MAX));
        assert_eq!(mul_div_floor(MAX, 2, 1), None);
        assert_eq!(mul_div_ceil(MAX, MAX - 1, MAX), Some(MAX - 1));
        assert_eq!(mul_div_ceil(MAX, 3, 2), None);
        assert_eq!(mul_div_floor(7, 3, 0), None);
    }

    #[test]
    fn identities_on_the_wide_path() {
        let mut rng = SplitMix(7);
        for _ in 0..20_000 {
            let (a, b) = (rng.value(), rng.value());
            if b != 0 {
                assert_eq!(mul_div_floor(a, b, b), Some(a));
                assert_eq!(mul_div_ceil(a, b, b), Some(a));
            }
            if a != 0 {
                assert_eq!(mul_div_floor(a, b, a), Some(b));
            }
        }
    }

    #[test]
    fn random_triples() {
        let mut rng = SplitMix(20_261_114);
        for _ in 0..200_000 {
            check(rng.value(), rng.value(), rng.value());
        }
    }

    #[test]
    fn wide_divisor() {
        let total = wide_sum(&[MAX, MAX, 5]);
        assert_eq!(narrow(total), None);
        // MAX * (MAX - 1) / (2 * MAX + 5) is just below MAX / 2.
        let q = mul_div_floor_wide(MAX, MAX - 1, total).expect("fits");
        assert!(U256::new(q) * total <= wide_mul(MAX, MAX - 1));
        assert!(U256::new(q + 1) * total > wide_mul(MAX, MAX - 1));
        assert_eq!(mul_div_floor_wide(1, 1, U256::ZERO), None);
        assert_eq!(mul_div_floor_wide(MAX, MAX, U256::ONE), None);
    }
}
