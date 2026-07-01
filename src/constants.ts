// Hardcoded stablecoins treated as $1. Used to bootstrap the USD pricing
// graph: any token paired with one of these in a Curve cryptoswap pool gets
// its usdPrice derived from the swap ratio. WETH/WBTC aren't listed here —
// they get priced via tricrypto pools where coin 0 is a stablecoin.
//
// Addresses are lower-cased for membership checks.

export const STABLECOINS: Record<number, Set<string>> = {
  // Ethereum mainnet
  1: new Set(
    [
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
      "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
      "0x853d955aCEf822Db058eb8505911ED77F175b99e", // FRAX
      "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", // crvUSD
      "0x0000000000085d4780B73119b644AE5ecd22b376", // TUSD
      "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", // USDe
      "0x8E870D67F660D95d5be530380D0eC0bd388289E1", // USDP (Pax Dollar)
      "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", // PYUSD
      "0x056Fd409E1d7A124BD7017459dFEa2F387b6d5Cd", // GUSD
      "0x99D8a9C45b2ecA8864373A26D1459e3Dff1e17F3", // MIM
      "0x57Ab1ec28D129707052df4dF418D58a2D46d5f51", // sUSD
    ].map((a) => a.toLowerCase()),
  ),
  // Arbitrum
  42161: new Set(
    [
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC (native)
      "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", // USDC.e (bridged)
      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
      "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
      "0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F", // FRAX
      "0x498Bf2B1e120FeD3ad3D42EA2165E9b73f99C1e5", // crvUSD
      "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", // USDe
      "0x4D15a3A2286D883AF0AA1B3f21367843FAc63E07", // TUSD
    ].map((a) => a.toLowerCase()),
  ),
};

export function isStablecoin(chainId: number, address: string): boolean {
  return STABLECOINS[chainId]?.has(address.toLowerCase()) ?? false;
}

// Tokens the swap-derived price graph mis-prices badly enough to inflate pool
// TVL. We refuse to derive a price for them, refuse to price other tokens off
// them, and count them as $0 in TVL (see pricing.ts). Addresses lower-cased for
// membership checks (mirrors STABLECOINS).
export const BLACKLIST: Record<number, Set<string>> = {
  // Ethereum mainnet
  1: new Set(
    [
      "0x166c293f2e3b180f00b25e82ad5b592a7c8f4d3d", // ₿Gold
      "0xb38d44c98e001195c017f6ef7645b5737579080f", // FLY
      "0xf951e335afb289353dc249e82926178eac7ded78", // swETH
      "0xc3ade5ace1bbb033ccae8177c12ecbfa16bd6a9d", // InswETH
    ].map((a) => a.toLowerCase()),
  ),
};

export function isBlacklisted(chainId: number, address: string): boolean {
  return BLACKLIST[chainId]?.has(address.toLowerCase()) ?? false;
}

export function tokenId(chainId: number, address: string): string {
  return `${chainId}_${address.toLowerCase()}`;
}
