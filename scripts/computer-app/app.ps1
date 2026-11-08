# The Windows test window of the computer check: pressing the button writes the field to the file named first.
param([string]$Out)
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = "测试窗口"
$form.Width = 420
$form.Height = 220
$name = New-Object System.Windows.Forms.TextBox
$name.Top = 10; $name.Left = 10; $name.Width = 360
$name.AccessibleName = "姓名"
$secret = New-Object System.Windows.Forms.TextBox
$secret.Top = 50; $secret.Left = 10; $secret.Width = 360
$secret.UseSystemPasswordChar = $true
$secret.AccessibleName = "口令"
$button = New-Object System.Windows.Forms.Button
$button.Top = 90; $button.Left = 10; $button.Text = "确定"
$button.AccessibleName = "确定"
$button.Add_Click({
    [System.IO.File]::WriteAllText($Out, $name.Text, (New-Object System.Text.UTF8Encoding $false))
    $form.Close()
})
$form.Controls.AddRange(@($name, $secret, $button))
[void]$form.ShowDialog()
