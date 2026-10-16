// In the repository this re-exports the hub's read-only research layer, so there is one copy of the source list and the search plans.
// Setup-GcpResearchAgent.ps1 replaces this file with the real hub file when it builds the container image.
export * from '../hub-mcp/src/research.mjs'
