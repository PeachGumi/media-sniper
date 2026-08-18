#!/usr/bin/env python3
"""Write download prefs into a dedicated Brave test profile so automated
chrome.downloads.download() calls never stall on a Save-As dialog.

Usage: write_prefs.py [profile_name]   (default: ms-brave-test)
Run BEFORE launching the browser with that --user-data-dir.
"""
import json, os, sys

profile = sys.argv[1] if len(sys.argv) > 1 else "ms-brave-test"
base = os.path.expanduser(f"~/.cache/{profile}/Default")
os.makedirs(base, exist_ok=True)
prefs = {
    'download': {
        'prompt_for_download': False,
        'default_directory': os.path.expanduser('~/Downloads'),
    },
}
path = os.path.join(base, 'Preferences')
with open(path, 'w') as f:
    json.dump(prefs, f)
print('written', path)
