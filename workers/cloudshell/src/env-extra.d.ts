// Optional secret for the Gemini CLI in the owner shell's working sessions. Set it with rabbit-web/scripts/powershell/Setup-CloudshellGeminiKey.ps1; unset = Gemini is installed but cannot call the API.
interface Env {
  GEMINI_API_KEY?: string;
}
