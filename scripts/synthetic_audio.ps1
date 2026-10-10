$ErrorActionPreference = 'Stop'
$outputDirectory = Join-Path $PSScriptRoot '../.local/inbox'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $outputDirectory 'fictional-function-lesson.wav'))
$voice = New-Object -ComObject SAPI.SpVoice
$voices = $voice.GetVoices()
for ($i = 0; $i -lt $voices.Count; $i++) {
    if ($voices.Item($i).GetDescription() -match 'Chinese|Huihui') {
        $voice.Voice = $voices.Item($i)
        break
    }
}
$stream = New-Object -ComObject SAPI.SpFileStream
$stream.Format.Type = 22
$stream.Open($outputPath, 3, $false)
try {
    $voice.AudioOutputStream = $stream
    $voice.Rate = -2
    $textPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../tests/fixtures/synthetic-audio.txt'))
    $voice.Speak([System.IO.File]::ReadAllText($textPath, [System.Text.Encoding]::UTF8)) | Out-Null
} finally {
    $stream.Close()
}
Write-Output $outputPath
