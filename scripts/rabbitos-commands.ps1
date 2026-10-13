#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('cloudflare', 'console', 'core')]
    [string]$Area = 'cloudflare',
    [ValidateSet('Setup', 'Validate', 'Dev', 'PublishCommands', 'DeployCommands', 'VaultCommands')]
    [string]$Action = 'Validate',
    [string]$Repository,
    [ValidateSet('site', 'sync', 'node-worker', 'gateway')]
    [string]$Target = 'site',
    [string]$Vault = (Join-Path $env:USERPROFILE 'Documents\RabbitOS Vault'),
    [switch]$Preview
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Repository) {
    $Repository = switch ($Area) {
        'cloudflare' { $root }
        'console' { Join-Path $env:USERPROFILE 'Projects\rabbit-web' }
        'core' { Join-Path $Vault 'GitHub Live\Repairs\RABBIT-SOFTWARE-pylint' }
    }
}
$Repository = (Resolve-Path -LiteralPath $Repository).Path
$marker = switch ($Area) {
    'cloudflare' { 'scripts\sync-github-vault.py' }
    'console' { 'src\lib\tasks.ts' }
    'core' { 'rabbit-os\core\event_bus.py' }
}
if (-not (Test-Path -LiteralPath (Join-Path $Repository $marker))) {
    throw "Missing $marker in $Repository. Select the correct checkout with -Repository; restore core sparse paths if necessary."
}

function Quote-Argument([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

function Run-Command([string]$Program, [string[]]$Arguments) {
    Write-Output ("& " + (Quote-Argument $Program) + " " +
        (($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' '))
    if (-not $Preview) {
        & $Program @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Program failed with exit code $LASTEXITCODE. Remaining commands were not run."
        }
    }
}

function Show-Command([string]$Command) {
    Write-Output $Command
    Write-Output 'if ($LASTEXITCODE -ne 0) { throw "Command failed; stop and review before continuing." }'
}

Write-Output "# $Area / $Action"
Write-Output ("Set-Location -LiteralPath " + (Quote-Argument $Repository))
Push-Location -LiteralPath $Repository
$previousBytecode = $env:PYTHONDONTWRITEBYTECODE
try {
    $env:PYTHONDONTWRITEBYTECODE = '1'
    switch ($Action) {
        'Setup' {
            Run-Command 'git' @('--version')
            Run-Command 'python' @('--version')
            if ($Area -eq 'core') {
                Write-Output '# The focused core tests use only the Python standard library.'
                Write-Output '# Full application dependencies and missing module sources still require review; no guessed packages are installed.'
            } else {
                if (-not (Test-Path -LiteralPath 'package-lock.json')) {
                    throw 'Missing package-lock.json; refusing an unpinned dependency install.'
                }
                Run-Command 'node' @('--version')
                Run-Command 'npm.cmd' @('ci')
                Write-Output '# Local credentials are not generated or copied. Keep .env.local and .dev.vars untracked.'
            }
        }
        'Validate' {
            switch ($Area) {
                'cloudflare' {
                    Run-Command 'python' @('-m', 'unittest',
                        'scripts\test-import-github-vault.py',
                        'scripts\test-sync-github-vault.py',
                        'scripts\test-audit-vault-repos.py',
                        'scripts\test-rabbitos-commands.py')
                }
                'console' {
                    Run-Command 'node' @('--test', 'tests\tasks.test.mjs',
                        'tests\mcp.test.mjs', 'tests\connections.test.mjs',
                        'tests\twin-interop.test.mjs')
                    Run-Command 'npx.cmd' @('--no-install', 'tsc', '--noEmit')
                    Run-Command 'npx.cmd' @('--no-install', 'eslint',
                        'src\lib\tasks.ts', 'src\lib\connections.ts')
                }
                'core' {
                    Run-Command 'python' @('-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py')
                }
            }
            Run-Command 'git' @('--no-pager', 'diff', '--check')
        }
        'Dev' {
            if ($Area -eq 'core') {
                throw 'A complete runnable Python application/dependency setup has not been verified. Use Validate; do not execute the shell-instruction documents as Python.'
            }
            if ($Area -eq 'console') {
                Write-Output '# The console may reach its configured Supabase project; do not exercise remote writes without approval.'
                Run-Command 'npm.cmd' @('run', 'dev:vinext')
            } elseif ($Target -eq 'site') {
                Run-Command 'npm.cmd' @('run', 'dev:site')
            } else {
                $port = @{ sync = '8801'; 'node-worker' = '8802'; gateway = '8803' }[$Target]
                Write-Output '# Bindings are local. Outbound HTTP calls are not disabled by --local; do not send private inputs.'
                Write-Output '# Start sync before node-worker, in a separate terminal, for the local ArchiveAgent service.'
                Run-Command 'npx.cmd' @('--no-install', 'wrangler', 'dev',
                    '--config', "workers\$Target\wrangler.dev.toml", '--local', '--port', $port)
            }
        }
        'PublishCommands' {
            Write-Output '# PREVIEW ONLY. Review every diff and branch before manually staging, committing or publishing.'
            Write-Output '# Never publish these repairs directly from main/master. Private repositories require explicit publication approval.'
            Show-Command 'git status --short'
            Show-Command 'git --no-pager diff'
            Show-Command '$branch = git branch --show-current'
            Write-Output 'if (-not $branch -or $branch -in @("main", "master")) { throw "Use a named repair branch before publication." }'
            Write-Output '# Stage reviewed paths explicitly; do not use git add -A when unrelated changes are present.'
            $paths = switch ($Area) {
                'cloudflare' {
                    @('DEVELOPMENT.md', '.vscode\tasks.json', 'scripts\index-vault-library.py',
                        'scripts\test-sync-github-vault.py', 'scripts\rabbitos-commands.ps1',
                        'scripts\test-rabbitos-commands.py')
                }
                'console' {
                    @('docs\rabbitos.md', 'src\lib\tasks.ts', 'src\lib\connections.ts',
                        'tests\tasks.test.mjs', 'tests\connections.test.mjs')
                }
                'core' {
                    @('.github\workflows\pylint.yml', 'docs\pylint-workflow.md',
                        'docs\dna-quantum-crypto-instructions.md', 'docs\neural-memory-to-image-instructions.md',
                        'rabbit-os\core\event_bus.py', 'tests\test_event_bus.py',
                        'pip install -r requirements.txt sudo python3 dna_quantum_crypto.py',
                        'python neural_memory_to_image.py')
                }
            }
            Show-Command ('git add --sparse -- ' + (($paths | ForEach-Object { Quote-Argument $_ }) -join ' '))
            Show-Command 'git --no-pager diff --cached'
            Show-Command "git commit -m 'fix: improve RabbitOS workflow reliability' -m 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'"
            Show-Command 'git push --set-upstream origin HEAD'
            $repoName = @{ cloudflare = 'rabbitsoftware-cloudflare'; console = 'rabbit-web'; core = 'RABBIT-SOFTWARE' }[$Area]
            $github = "ringquistchase-collab/$repoName"
            Show-Command ("gh pr list --repo $github --head " + '(git branch --show-current)')
            Write-Output '# Only create a draft if this branch has no existing PR. Otherwise update that PR.'
            Show-Command ("gh pr create --repo $github --base main --draft --title 'fix: improve RabbitOS workflow reliability' --body 'Local reliability repairs and regression tests. Review the diff and validation results before merge; no deployment is included.'")
            Show-Command ("gh run list --repo $github --branch " + '(git branch --show-current) --limit 5')
            if ($Area -eq 'core') {
                Write-Output '# The local follow-up is based on PR #18. Review stacking/base strategy before creating a second PR.'
            }
        }
        'DeployCommands' {
            Write-Output '# PREVIEW ONLY. Requires separate deployment approval, current binding/secret review and validation.'
            if ($Area -eq 'core') {
                Write-Output '# No verified Python deployment target exists. Do not invent a Worker or run unverified instruction files.'
            } elseif ($Area -eq 'console') {
                Write-Output '# Use the existing vinext/Cloudflare configuration, not a direct Wrangler deployment.'
                Show-Command 'npm run build:vinext'
                Show-Command 'npm run deploy:vinext'
            } elseif ($Target -eq 'site') {
                Write-Output '# Preview is a remote Pages write, not a local test. Production uses the documented master Pages branch.'
                Show-Command 'npm run preview:site'
                Show-Command "npx --no-install wrangler pages deploy site --project-name rabbitsoftware-site --branch master"
            } else {
                Show-Command ("npx --no-install wrangler deploy --config workers\$Target\wrangler.toml --dry-run")
                Write-Output '# Recover/review original sources for generated bundles before production deployment.'
                Write-Output '# Verify dashboard bindings/secrets against config; deploy sync before node-worker.'
                Write-Output '# Production command below is not approval to execute it.'
                Show-Command ("npx --no-install wrangler deploy --config workers\$Target\wrangler.toml")
            }
        }
        'VaultCommands' {
            if ($Area -ne 'cloudflare') {
                throw 'Vault tooling lives in the Cloudflare repository; use -Area cloudflare.'
            }
            $quotedVault = Quote-Argument $Vault
            Write-Output '# PREVIEW ONLY. Verification and indexing do not publish personal files.'
            Show-Command "python scripts\sync-github-vault.py --vault $quotedVault --verify-only"
            Write-Output '# The audit fetches GitHub metadata; it does not upload vault note contents.'
            Show-Command "python scripts\audit-vault-repos.py --vault $quotedVault"
            $sources = @('Documents', 'Downloads', 'OneDrive', 'Music', 'Videos') |
                ForEach-Object { '--source ' + (Quote-Argument (Join-Path $env:USERPROFILE $_)) }
            Show-Command ("python scripts\index-vault-library.py --vault $quotedVault " + ($sources -join ' '))
            Write-Output "Get-ScheduledTask -TaskName 'RabbitOS GitHub Vault Sync'"
            Write-Output "Get-ScheduledTaskInfo -TaskName 'RabbitOS GitHub Vault Sync'"
            Write-Output '# Inspect the existing task; do not register a duplicate. Regular sync can publish approved public-repo changes.'
        }
    }
} finally {
    $env:PYTHONDONTWRITEBYTECODE = $previousBytecode
    Pop-Location
}
