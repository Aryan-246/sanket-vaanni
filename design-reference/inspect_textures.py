import bpy
import json
import os

results = {}
for p in [
    r'c:\PROJECT\SANKET VAANNI\design-reference\extracted\fps-female-arms\textures\[FPS_Female_Arms]_[FPS_Female_Arms]_Materi.png',
    r'c:\PROJECT\SANKET VAANNI\design-reference\extracted\vr-hands\textures\T_VRHands_Base_color.png'
]:
    img = bpy.data.images.load(p)
    results[os.path.basename(p)] = {
        "width": img.size[0],
        "height": img.size[1],
        "channels": img.channels,
        "depth": img.depth,
        "colorspace": img.colorspace_settings.name,
        "file_bytes": os.path.getsize(p)
    }

out_p = r'c:\PROJECT\SANKET VAANNI\design-reference\evaluation_output\textures_info.json'
with open(out_p, 'w') as f:
    json.dump(results, f, indent=2)

print("Saved texture info to:", out_p)
