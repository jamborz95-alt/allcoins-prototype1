from pathlib import Path
from PIL import Image, ImageEnhance, ImageFilter
import numpy as np

source = Path("cars/lada-2107-side.png")
target = Path("cars/lada-2107-side-hq.webp")

if not source.exists():
    raise SystemExit("Source car sprite not found")

original = Image.open(source).convert("RGBA")
scale = 3
width, height = original.size
new_size = (width * scale, height * scale)

# Upscale the exact existing sprite. Premultiplied-alpha resizing prevents
# dark fringes around the transparent silhouette.
pixels = np.asarray(original, dtype=np.float32)
alpha = pixels[:, :, 3] / 255.0
premultiplied = pixels[:, :, :3] * alpha[:, :, None]

premul_image = Image.fromarray(np.clip(premultiplied, 0, 255).astype("uint8"), "RGB")
alpha_image = original.getchannel("A")

premul_up = np.asarray(premul_image.resize(new_size, Image.Resampling.LANCZOS), dtype=np.float32)
alpha_up = np.asarray(alpha_image.resize(new_size, Image.Resampling.LANCZOS), dtype=np.float32) / 255.0

with np.errstate(divide="ignore", invalid="ignore"):
    rgb_up = np.where(alpha_up[:, :, None] > 1e-5,
                      premul_up / np.maximum(alpha_up[:, :, None], 1e-5),
                      0.0)
rgb_up = np.clip(rgb_up, 0, 255).astype("uint8")

rgb = Image.fromarray(rgb_up, "RGB")
# Small clarity adjustments only; no geometry, colour identity, or details are redrawn.
rgb = ImageEnhance.Contrast(rgb).enhance(1.035)
rgb = ImageEnhance.Color(rgb).enhance(1.025)
rgb = rgb.filter(ImageFilter.UnsharpMask(radius=1.6, percent=105, threshold=3))

result = rgb.convert("RGBA")
result.putalpha(Image.fromarray(np.clip(alpha_up * 255, 0, 255).astype("uint8"), "L"))
result.save(target, "WEBP", quality=94, method=6, exact=True)

check = Image.open(target)
if check.size != new_size or check.mode != "RGBA":
    raise SystemExit("High-resolution sprite validation failed")
print(f"Created {target}: {check.width}x{check.height}, alpha preserved")
