# Homebrew Cask for napkin.
#
# Goes in a tap repo; the canonical location is
# `napkin-term/homebrew-napkin/Casks/napkin.rb` (tap not yet created — add
# this file by hand the first time the tap exists, then the GitHub
# Actions release workflow can update version + sha256 on each tag).

cask "napkin" do
  version "0.1.0"
  sha256 :no_check

  on_arm do
    url "https://github.com/johndockery/napkin/releases/download/v#{version}/napkin_#{version}_aarch64-apple-darwin.dmg"
  end
  on_intel do
    url "https://github.com/johndockery/napkin/releases/download/v#{version}/napkin_#{version}_x86_64-apple-darwin.dmg"
  end

  name "napkin"
  desc "Terminal with first-class workspaces, structured scrollback, and agent-awareness"
  homepage "https://github.com/johndockery/napkin"

  app "napkin.app"

  binary "#{appdir}/napkin.app/Contents/MacOS/napkin"
  binary "#{appdir}/napkin.app/Contents/MacOS/napkind"

  zap trash: [
    "~/Library/Application Support/dev.napkin.app",
    "~/Library/Preferences/dev.napkin.app.plist",
    "~/Library/Saved Application State/dev.napkin.app.savedState",
    "~/.local/share/napkin",
    "~/.config/napkin",
  ]
end
