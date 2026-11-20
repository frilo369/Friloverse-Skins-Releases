#requires -Version 5.1
<#
.SYNOPSIS
    Read-only local Windows diagnostics collector for Friloverse Skins and LTK Manager.
.DESCRIPTION
    Never changes registry/security settings, never restarts League, and never uploads anything.
    Writes report.txt and report.json to the output folder with credentials and profile paths redacted.
#>
[CmdletBinding()]
param(
    [string]$AppPath,
    [string]$DataPath,
    [string]$OutputDirectory,
    [string]$AppVersion = '',
    [ValidateRange(1, 30)][int]$Days = 7,
    [switch]$SkipNetworkChecks
)

$ErrorActionPreference = 'Stop'
$script:Findings = New-Object 'System.Collections.Generic.List[object]'
$script:Started = Get-Date
$script:ProfilePath = $env:USERPROFILE

function Protect-Text([AllowNull()][object]$Value) {
    $text = [string]$Value
    if ($script:ProfilePath) {
        $text = [regex]::Replace($text, '(?i)' + [regex]::Escape($script:ProfilePath.TrimEnd('\')) + '(?=[\\/\s"'']|$)', '%USERPROFILE%')
    }
    $text = [regex]::Replace($text, '(?i)[A-Z]:[\\/]Users[\\/][^\\/\r\n"<>]+', '%USERPROFILE%')
    $text = [regex]::Replace($text, '(?i)(--(?:remoting-auth-token|riotclient-auth-token|auth-token)=)(?:"[^"]*"|[^\s]+)', '$1<redacted>')
    $text = [regex]::Replace($text, '(?i)(authorization\s*[:=]\s*(?:basic|bearer)\s+)[A-Za-z0-9+/=_\-.]+', '$1<redacted>')
    $text = [regex]::Replace($text, '(?i)([?&](?:reconnect|token|auth)=)[A-Za-z0-9._-]+', '$1<redacted>')
    $text = [regex]::Replace($text, '(?i)(["'']?(?:password|token|access_token|refresh_token|auth_token|api_key|puuid)["'']?\s*[:=]\s*)(?:"[^"]*"|''[^'']*''|[^\s,;]+)', '$1<redacted>')
    $text = [regex]::Replace($text, '(?i)\bS-1-5-21-(?:\d+-){2,3}\d+\b', '<redacted-sid>')
    return $text
}

function Add-Finding([string]$Id, [string]$Stage, [string]$Status, [string]$Summary, [object]$Evidence = '', [string]$NextStep = '') {
    $script:Findings.Add([pscustomobject][ordered]@{
        id = $Id; stage = $Stage; status = $Status
        summary = Protect-Text $Summary
        evidence = Protect-Text $Evidence
        nextStep = Protect-Text $NextStep
    })
}

function Invoke-Check([string]$Id, [string]$Stage, [scriptblock]$Action) {
    Write-Host ("Checking {0}..." -f $Id)
    try { & $Action }
    catch {
        Add-Finding $Id $Stage 'UNKNOWN' 'Check could not finish.' $_.Exception.Message ''
    }
    finally {
        Write-Reports -Incomplete
    }
}

if (-not $OutputDirectory) {
    $base = if ($DataPath) { Join-Path $DataPath 'diagnostics' } else { Join-Path $env:APPDATA 'friloverse-skins\diagnostics' }
    $OutputDirectory = Join-Path $base ('Friloverse-Diagnostics-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

function Write-Reports([switch]$Incomplete) {
    $rank = @{ 'FAIL' = 0; 'WARN' = 1; 'UNKNOWN' = 2; 'INFO' = 3; 'PASS' = 4 }
    $sorted = $script:Findings | Sort-Object { $rank[$_.status] }, stage, id
    $payload = [ordered]@{
        app = 'Friloverse Skins'
        version = $AppVersion
        started = $script:Started.ToString('o')
        finished = (Get-Date).ToString('o')
        incomplete = [bool]$Incomplete
        findings = $sorted
    }
    $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'report.json') -Encoding UTF8
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $lines.Add("Friloverse Skins Diagnostics ($AppVersion) - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    if ($Incomplete) { $lines.Add('[IN PROGRESS / PARTIAL CHECKPOINT]') }
    $lines.Add('=' * 72)
    foreach ($f in $sorted) {
        $lines.Add("[$($f.status)] ($($f.stage)) $($f.id): $($f.summary)")
        if ($f.evidence) { $lines.Add("  Evidence: $($f.evidence)") }
        if ($f.nextStep) { $lines.Add("  Fix:      $($f.nextStep)") }
    }
    $lines -join "`r`n" | Set-Content -LiteralPath (Join-Path $OutputDirectory 'report.txt') -Encoding UTF8
}

Invoke-Check 'os.version' 'Environment' {
    $os = Get-CimInstance Win32_OperatingSystem
    Add-Finding 'os.version' 'Environment' 'INFO' "$($os.Caption) (Build $($os.BuildNumber))" "Arch=$($os.OSArchitecture); FreeRAM=$([math]::Round($os.FreePhysicalMemory/1MB,2))GB" ''
}

Invoke-Check 'uac.enablelua' 'Environment' {
    $val = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLUA -ErrorAction SilentlyContinue).EnableLUA
    if ($val -eq 0) {
        Add-Finding 'uac.enablelua' 'Environment' 'FAIL' 'Windows UAC (EnableLUA) is disabled (0).' 'EnableLUA=0' 'Turn Windows UAC back on and restart Windows: LTK Manager refuses to patch when every program runs elevated.'
    } else {
        Add-Finding 'uac.enablelua' 'Environment' 'PASS' 'Windows UAC is enabled.' "EnableLUA=$val" ''
    }
}

Invoke-Check 'appcompat.runasadmin' 'Elevation' {
    $hits = @()
    foreach ($root in @('HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers', 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers')) {
        if (Test-Path $root) {
            $props = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue
            foreach ($p in $props.PSObject.Properties) {
                if ($p.Name -notlike 'PS*' -and ($p.Value -match '(?i)\bRUNASADMIN\b') -and ($p.Name -match '(?i)(league|riot|ltk|friloverse)')) {
                    $hits += "$($root.Split(':')[0]): $($p.Name) = $($p.Value)"
                }
            }
        }
    }
    if ($hits.Count -gt 0) {
        Add-Finding 'appcompat.runasadmin' 'Elevation' 'FAIL' 'RUNASADMIN compatibility flag found on League/LTK/Friloverse executables.' ($hits -join '; ') 'Remove Run as administrator in Properties -> Compatibility (and Change settings for all users) for all listed executables.'
    } else {
        Add-Finding 'appcompat.runasadmin' 'Elevation' 'PASS' 'No conflicting RUNASADMIN compatibility flags found.' '' ''
    }
}

Invoke-Check 'security.sac' 'Security' {
    $state = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
    if ($state -eq 1) {
        Add-Finding 'security.sac' 'Security' 'WARN' 'Windows Smart App Control is ON (enforcing).' 'VerifiedAndReputablePolicyState=1' 'Smart App Control can silently block unsigned helpers (ltk_launcher.exe / LeagueToolFlop.dll).'
    } else {
        Add-Finding 'security.sac' 'Security' 'PASS' "Smart App Control state=$state (not enforcing)." '' ''
    }
}

Invoke-Check 'security.av' 'Security' {
    $products = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction SilentlyContinue)
    foreach ($p in $products) {
        Add-Finding 'security.av' 'Security' 'INFO' "Registered AV: $($p.displayName)" "state=$($p.productState)" ''
        if ($p.displayName -match '(?i)\b360\b|Qihoo') {
            Add-Finding 'security.av.360' 'Security' 'WARN' '360/Qihoo detected (known silent blocker for LTK/LTF).' $p.displayName 'Check 360 quarantine and behavior blocking history.'
        }
    }
}

Invoke-Check 'security.events' 'Security' {
    $since = (Get-Date).AddDays(-$Days)
    $channels = @(
        @{ Log = 'Microsoft-Windows-CodeIntegrity/Operational'; Ids = @(3033, 3077) },
        @{ Log = 'Microsoft-Windows-Windows Defender/Operational'; Ids = @(1116, 1117, 1118, 1119, 1121, 1122, 1125, 1126) }
    )
    foreach ($ch in $channels) {
        try {
            $evts = @(Get-WinEvent -FilterHashtable @{ LogName = $ch.Log; Id = $ch.Ids; StartTime = $since } -MaxEvents 200 -ErrorAction SilentlyContinue |
                Where-Object { $_.Message -match '(?i)(friloverse|ltk|leaguetoolflop|league)' })
            if ($evts.Count -gt 0) {
                $sample = ($evts | Select-Object -First 3 | ForEach-Object { "$($_.TimeCreated.ToString('s')) [$($_.Id)] $($_.Message.Split("`n")[0])" }) -join ' | '
                Add-Finding "events.$($ch.Log)" 'Security' 'WARN' "$($evts.Count) relevant security block event(s) in $($ch.Log)." $sample 'Review Windows Security / CodeIntegrity history for blocked Friloverse or LTK binaries.'
            } else {
                Add-Finding "events.$($ch.Log)" 'Security' 'PASS' "No relevant blocks in $($ch.Log) (last $Days days)." '' ''
            }
        } catch {
            Add-Finding "events.$($ch.Log)" 'Security' 'UNKNOWN' "Could not query $($ch.Log)." $_.Exception.Message ''
        }
    }
}

Invoke-Check 'binaries.ltf' 'Files' {
    $candidates = @()
    if ($AppPath) {
        $candidates += (Join-Path $AppPath 'resources\app\src\native\ltf\ltk_launcher.exe')
        $candidates += (Join-Path $AppPath 'resources\app\src\native\ltf\LeagueToolFlop.dll')
        $candidates += (Join-Path $AppPath 'src\native\ltf\ltk_launcher.exe')
        $candidates += (Join-Path $AppPath 'src\native\ltf\LeagueToolFlop.dll')
    }
    foreach ($bin in ($candidates | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $bin) {
            $motw = Get-Content -LiteralPath $bin -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue
            $hash = (Get-FileHash -LiteralPath $bin -Algorithm SHA256).Hash.Substring(0, 16)
            if ($motw) {
                Add-Finding "binary.$(Split-Path -Leaf $bin)" 'Files' 'WARN' "$(Split-Path -Leaf $bin) carries Mark-of-the-Web (Zone.Identifier)." "sha256=$hash" 'Unblock the file in Properties or reinstall via Complete Setup.'
            } else {
                Add-Finding "binary.$(Split-Path -Leaf $bin)" 'Files' 'PASS' "$(Split-Path -Leaf $bin) present and unblocked." "sha256=$hash" ''
            }
        }
    }
}

Invoke-Check 'ltk.builtins' 'LTK' {
    $settings = Join-Path $env:APPDATA 'dev.leaguetoolkit.manager\settings.json'
    if (Test-Path -LiteralPath $settings) {
        $json = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
        if ($json.builtinMods.baseSkins -eq 'allChampions' -or $json.builtinMods.characterInking.scope -eq 'all') {
            Add-Finding 'ltk.builtins' 'LTK' 'WARN' 'LTK Manager heavy built-in mods are enabled (allChampions/all).' ($json.builtinMods | ConvertTo-Json -Compress) 'Disable allChampions built-in mods in LTK Manager settings.'
        } else {
            Add-Finding 'ltk.builtins' 'LTK' 'PASS' 'LTK Manager settings look clean.' '' ''
        }
    } else {
        Add-Finding 'ltk.builtins' 'LTK' 'WARN' 'LTK Manager settings.json not found.' $settings 'Install or start LTK Manager once.'
    }
}

if (-not $SkipNetworkChecks) {
    Invoke-Check 'clock.offset' 'Environment' {
        $out = & w32tm.exe /stripchart /computer:time.windows.com /samples:3 /dataonly 2>&1 | Out-String
        $samples = @([regex]::Matches($out, '(?m)([+-]\d+[.,]\d+)s\s*$') | ForEach-Object { [double]::Parse($_.Groups[1].Value.Replace(',', '.'), [Globalization.CultureInfo]::InvariantCulture) } | Sort-Object)
        if ($samples.Count -ge 2) {
            $median = $samples[[int][Math]::Floor($samples.Count / 2)]
            $st = if ([Math]::Abs($median) -gt 60) { 'WARN' } else { 'PASS' }
            Add-Finding 'clock.offset' 'Environment' $st ("Clock offset vs time.windows.com: {0:F2}s" -f $median) '' 'Enable automatic Windows time sync if drift exceeds 60 seconds.'
        } else {
            Add-Finding 'clock.offset' 'Environment' 'UNKNOWN' 'Could not sample time.windows.com.' '' ''
        }
    }
}

Write-Reports
Write-Host "Diagnostics written to $OutputDirectory"
