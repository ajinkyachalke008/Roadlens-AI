// Test-only TLS allowance for the isolated split-origin smoke harness.
// It must never bypass certificate validation for a deployed/public origin.
export function localTlsAllowed() {
  if (process.env.ROADLENS_TEST_LOCAL_TLS !== "1") return false;
  for (const name of ["ROADLENS_BASE_URL", "ROADLENS_RELAY_URL"]) {
    const url = new URL(process.env[name] ?? "");
    if (
      url.protocol !== "https:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      throw new Error(
        `${name} must be an HTTPS loopback origin for the local TLS test`,
      );
  }
  return true;
}
