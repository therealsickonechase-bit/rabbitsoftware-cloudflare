// Optional settings for running the visitor terminal on Google Cloud instead of Cloudflare Containers. Unset = the Cloudflare sandbox, as before.
interface Env {
  /** "gcp" sends the terminal to the Cloud Run service; anything else uses the Cloudflare sandbox. */
  TERMINAL_BACKEND?: string;
  /** https origin of the Cloud Run service (must end in .run.app). */
  GCP_SHELL_URL?: string;
  /** Shared secret that signs the short-lived token the Cloud Run service checks (secret, at least 32 characters). */
  PTY_BRIDGE_SECRET?: string;
}
