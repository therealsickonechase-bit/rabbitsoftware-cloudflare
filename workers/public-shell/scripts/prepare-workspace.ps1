<#
.SYNOPSIS
    Builds the clean, history-free code snapshot that the public sandbox image copies into /workspace (and that can seed two public repos).
.DESCRIPTION
    Writes to workers\public-shell\workspace-src\{rabbit-web, rabbitsoftware-site}. It exports only COMMITTED files (git archive), so working-tree
    secrets, .env files, .claude, node_modules and git history are never included. It then removes known-private paths, redacts the owner's personal email
    address, and REFUSES to finish if anything that looks like a real credential is still present. Nothing is uploaded.
#>
[CmdletBinding()]
param(
    [string]$RabbitWeb = 'C:\Users\odaat\Projects\rabbit-web',
    [string]$Cloudflare = 'C:\Users\odaat\Projects\rabbitsoftware-cloudflare',
    [string]$Out = (Join-Path (Split-Path $PSScriptRoot -Parent) 'workspace-src'),
    [string[]]$RedactEmails = @('ringquistchase@gmail.com')
)
$ErrorActionPreference = 'Stop'
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force "$Out\rabbit-web", "$Out\rabbitsoftware-site" | Out-Null

git -C $RabbitWeb archive --format=tar HEAD | tar -x -C "$Out\rabbit-web"
if ($LASTEXITCODE -ne 0) { throw 'git archive (rabbit-web) failed' }
git -C $Cloudflare archive --format=tar HEAD site | tar -x -C "$Out\rabbitsoftware-site"
if ($LASTEXITCODE -ne 0) { throw 'git archive (site) failed' }

# Private paths that must never be in a public snapshot.
$drop = @('.claude', '.agents', '.mcp.json', 'backup', 'Hello-World', 'supabase\all_pending_migrations.sql')
foreach ($d in $drop) { foreach ($root in "$Out\rabbit-web", "$Out\rabbitsoftware-site") { $p = Join-Path $root $d; if (Test-Path $p) { Remove-Item $p -Recurse -Force } } }
Get-ChildItem $Out -Recurse -Force -File | Where-Object { $_.Name -match '^(\.env($|\.)|\.dev\.vars)' -or $_.Extension -in '.pem', '.key', '.sqlite', '.db' } | Remove-Item -Force

# Redact personal email addresses in text files.
$textExt = '.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.sql', '.html', '.css', '.yml', '.yaml', '.txt', '.ps1', '.py', '.toml', '.jsonc'
$redacted = 0
foreach ($f in Get-ChildItem $Out -Recurse -File | Where-Object { $_.Extension -in $textExt -and $_.Length -lt 3MB }) {
    $t = [IO.File]::ReadAllText($f.FullName); $o = $t
    foreach ($e in $RedactEmails) { $t = $t -ireplace [regex]::Escape($e), 'owner@example.invalid' }
    if ($t -ne $o) { [IO.File]::WriteAllText($f.FullName, $t); $redacted++ }
}

# Refuse if anything credential-shaped remains, ignoring obvious test fixtures (a match containing fake/test/example/dummy/xxxx/aaaa).
$pat = 'sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/ ]{20,}'
$bad = foreach ($f in Get-ChildItem $Out -Recurse -File | Where-Object { $_.Length -lt 3MB }) {
    foreach ($m in (Select-String -LiteralPath $f.FullName -Pattern $pat -AllMatches -ErrorAction SilentlyContinue | ForEach-Object { $_.Matches })) {
        if ($m.Value -notmatch '(?i)fake|test|example|dummy|sample|xxxx|aaaa|0000|1234|abcd') { [pscustomobject]@{ File = $f.FullName.Substring($Out.Length + 1); Kind = $m.Value.Substring(0, [Math]::Min(6, $m.Value.Length)) + '...' } }
    }
}
if ($bad) { $bad | Format-Table -AutoSize | Out-String | Write-Host; throw "credential-looking strings remain in the snapshot ($(@($bad).Count)). Fix them before publishing." }
$count = (Get-ChildItem $Out -Recurse -File | Measure-Object).Count
$mb = [math]::Round((Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
"snapshot ready: $count files, $mb MB; emails redacted in $redacted files; no credential-looking strings; at $Out"
