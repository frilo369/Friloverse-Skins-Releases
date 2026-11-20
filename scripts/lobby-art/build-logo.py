# Makes the lobby's see-through friloverse-logo.webp from the owner's logo, gold on black (logo-source.png).
# Needs Pillow and numpy:
#   pip install --target %TEMP%\x\lib pillow numpy
#   set PYTHONPATH=%TEMP%\x\lib && python scripts\lobby-art\build-logo.py
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(HERE, '..', '..', 'src', 'ui')
# Three times the 404 pixels it takes on the lobby's stage, which is zoomed with the window.
WIDTH = 1212
# The picture's background is not quite black; this much counts as nothing.
FLOOR = 12
# Below SOFT only glow, which fades out. From SOLID up the letters are fully opaque.
SOFT, SOLID = 70, 140

picture = np.asarray(Image.open(os.path.join(HERE, 'logo-source.png')).convert('RGB')).astype(np.float32)
light = np.clip(picture - FLOOR, 0, 255)
peak = light.max(axis=2)
step = np.clip((peak - SOFT) / (SOLID - SOFT), 0, 1)
alpha = np.maximum(peak / 255, step * step * (3 - 2 * step))
# Take out the black each soft edge was mixed with, so the glow keeps its colour on any background.
colour = np.clip(light / np.maximum(alpha[..., None], 1 / 255), 0, 255)

rows = np.where((alpha > 0.04).any(axis=1))[0]
columns = np.where((alpha > 0.04).any(axis=0))[0]
top, bottom = max(rows[0] - 6, 0), min(rows[-1] + 7, alpha.shape[0])
left, right = max(columns[0] - 6, 0), min(columns[-1] + 7, alpha.shape[1])

cut = np.dstack((colour, alpha * 255))[top:bottom, left:right].round().astype(np.uint8)
logo = Image.fromarray(cut).convert('RGBa')
logo = logo.resize((WIDTH, round(logo.height * WIDTH / logo.width)), Image.LANCZOS).convert('RGBA')
logo.save(os.path.join(UI, 'friloverse-logo.webp'), quality=92, alpha_quality=100, method=6)
print(f'cut {right - left} x {bottom - top} from the source; logo {logo.width} x {logo.height}, '
      f'{logo.height * 404 / logo.width:.0f} tall on the stage')
