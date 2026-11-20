# Cuts the lobby's sky out of the owner's concept (home-concept.png, the window at 90,73 to 1575,913 of the picture).
# Everything standing on the sky is painted out, as the page draws it again: panels, buttons, words, the old logo.
# league-mark.webp and friloverse-logo.webp are separate (build-logo.py); the join and create nebulas stay in the sky.
#   pip install --target %TEMP%\x\lib pillow numpy opencv-python-headless
#   set PYTHONPATH=%TEMP%\x\lib && python scripts\lobby-art\build-home-art.py
import os
import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.normpath(os.path.join(HERE, '..', '..', 'src', 'ui'))
W, H = 1672, 941
WINDOW = (90, 73, 1575, 913)
source = np.array(Image.open(os.path.join(HERE, 'home-concept.png')).convert('RGB').crop(WINDOW).resize((W, H), Image.LANCZOS))

# In the stage's coordinates, where the concept has them.
SOLID = [(1180, 8, 1662, 70), (610, 0, 1056, 190), (440, 88, 612, 113), (1056, 88, 1215, 113), (62, 186, 1608, 364), (30, 812, 1640, 898),
         (800, 372, 845, 772), (765, 480, 880, 620),
         (375, 396, 515, 495), (175, 490, 725, 542), (170, 572, 735, 643), (198, 650, 706, 733),
         (1155, 396, 1266, 495), (918, 490, 1514, 542), (965, 648, 1466, 735)]
CARDS = [(75, 380, 803, 765), (840, 380, 1592, 765)]
EDGE = 7  # The painted window line; the page draws its own.


def mask_of_the_page():
    mask = np.zeros((H, W), np.uint8)
    for left, top, right, bottom in SOLID:
        mask[top:bottom, left:right] = 255
    for left, top, right, bottom in CARDS:
        keep = mask[top + 13:bottom - 13, left + 13:right - 13].copy()
        mask[top - 9:bottom + 9, left - 9:right + 9] = 255
        mask[top + 13:bottom - 13, left + 13:right - 13] = keep
        for x in (left, right - 62):
            for y in (top, bottom - 62):
                mask[y:y + 62, x:x + 62] = 255
    return mask


def sky():
    mask = mask_of_the_page()
    small = cv2.resize(source, (W // 3, H // 3), interpolation=cv2.INTER_AREA)
    small_mask = cv2.resize(mask, (W // 3, H // 3), interpolation=cv2.INTER_NEAREST)
    painted = cv2.inpaint(small, small_mask, 7, cv2.INPAINT_TELEA)
    wide = cv2.GaussianBlur(cv2.resize(painted, (W, H), interpolation=cv2.INTER_CUBIC), (0, 0), 5)
    soft = cv2.GaussianBlur(mask, (0, 0), 2)[..., None] / 255
    result = (source * (1 - soft) + wide * soft).round().astype(np.uint8)
    edge = np.zeros((H, W), np.uint8)
    edge[:EDGE] = edge[-EDGE:] = 255
    edge[:, :EDGE] = edge[:, -EDGE:] = 255
    return cv2.inpaint(result, edge, 5, cv2.INPAINT_TELEA)


Image.fromarray(sky()).save(os.path.join(UI, 'home-sky.webp'), quality=88, method=6)
