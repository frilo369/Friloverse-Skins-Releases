# Writes the app's copies of the owner's see-through Friloverse icon: friloverse-icon.webp (the League
# corner) and friloverse.ico (the program, the setup and the tray). The logo is build-logo.py.
#   pip install --target %TEMP%\x\lib pillow
#   set PYTHONPATH=%TEMP%\x\lib && python scripts\lobby-art\build-brand-art.py
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.normpath(os.path.join(HERE, '..', '..', 'src', 'ui'))


def trimmed(name):
    art = Image.open(os.path.join(HERE, name)).convert('RGBA')
    return art.crop(art.getchannel('A').point(lambda a: 255 if a > 12 else 0).getbbox())


art = trimmed('icon-source.webp')
side = max(art.size)
icon = Image.new('RGBA', (side, side), (0, 0, 0, 0))
icon.paste(art, ((side - art.width) // 2, (side - art.height) // 2))
icon.resize((192, 192), Image.LANCZOS).save(os.path.join(UI, 'friloverse-icon.webp'), quality=92, method=6)
# Plain bitmaps at every size: the setup compiler and the program's own resources both take those.
icon.resize((256, 256), Image.LANCZOS).save(os.path.join(UI, 'friloverse.ico'), sizes=[(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)], bitmap_format='bmp')
print('icon', side, 'files in', UI)
