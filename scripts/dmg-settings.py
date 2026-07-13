# Configuration dmgbuild pour le DMG d'installation macOS (raccourci /Applications + fond avec
# flèche) — lu par build-mac-native.sh via `python3 -m dmgbuild -s dmg-settings.py -D ...`.
# Ne dépend d'aucune automatisation Finder/AppleScript (contrairement à la recette hdiutil RW +
# osascript essayée avant, qui échouait en CI : Finder invisible/injoignable sur le runner GitHub
# Actions — erreurs -1728 puis -2700 même avec attente et sans -nobrowse).
#
# Positions {x, y} synchronisées avec resources/dmg-background.png (flèche entre les deux
# emplacements) — si l'un change, l'autre doit suivre.

app = defines.get("app")
app_name = defines.get("app_name")
background_path = defines.get("background")

format = "UDZO"
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
background = background_path
window_rect = ((100, 100), (660, 400))
icon_size = 128
icon_locations = {
    app_name + ".app": (180, 190),
    "Applications": (480, 190),
}
