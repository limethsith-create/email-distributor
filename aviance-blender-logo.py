"""
AVIANCE — Cinematic 3D Logo Reveal for Blender
================================================
Open Blender → Scripting tab → Open this file → Run Script
Renders a premium particle-assembly logo animation with:
  - 3D extruded metallic text with emission glow
  - Particle system forming the logo
  - Volumetric lighting with blue/purple palette
  - Camera animation (slow dolly + subtle rotation)
  - Deep bloom via compositor
  - 1920x1080 @ 30fps, 300 frames (10 seconds)

Output: renders to //aviance_logo_render/ folder next to your .blend file
"""

import bpy
import math
import random

# ═══════════════════════════════════════════════════
# 1. CLEAN SCENE
# ═══════════════════════════════════════════════════
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Remove all existing materials
for mat in bpy.data.materials:
    bpy.data.materials.remove(mat)

# Remove all meshes
for mesh in bpy.data.meshes:
    bpy.data.meshes.remove(mesh)

# ═══════════════════════════════════════════════════
# 2. SCENE SETTINGS
# ═══════════════════════════════════════════════════
scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end = 300
scene.frame_current = 1
scene.render.fps = 30
scene.render.resolution_x = 1920
scene.render.resolution_y = 1080
scene.render.resolution_percentage = 100

# Use Cycles for premium quality
scene.render.engine = 'CYCLES'
scene.cycles.samples = 128
scene.cycles.use_denoising = True
scene.cycles.device = 'GPU'  # Switch to 'CPU' if no GPU

# Film settings
scene.render.film_transparent = False
scene.render.image_settings.file_format = 'FFMPEG'
scene.render.ffmpeg.format = 'MPEG4'
scene.render.ffmpeg.codec = 'H264'
scene.render.ffmpeg.constant_rate_factor = 'HIGH'
scene.render.filepath = '//aviance_logo_render/aviance_reveal'

# World background — deep dark blue
world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg_node = world.node_tree.nodes.get("Background")
if bg_node:
    bg_node.inputs["Color"].default_value = (0.003, 0.004, 0.012, 1.0)
    bg_node.inputs["Strength"].default_value = 1.0

# ═══════════════════════════════════════════════════
# 3. CREATE 3D TEXT — "AVIANCE"
# ═══════════════════════════════════════════════════
bpy.ops.object.text_add(location=(0, 0, 0))
text_obj = bpy.context.object
text_obj.name = "AvianceLogo"
text_data = text_obj.data
text_data.body = "AVIANCE"
text_data.size = 1.2
text_data.extrude = 0.12
text_data.bevel_depth = 0.015
text_data.bevel_resolution = 4
text_data.align_x = 'CENTER'
text_data.align_y = 'CENTER'
text_data.space_character = 1.1

# Try to set a clean font (uses default if not available)
try:
    text_data.font = bpy.data.fonts.load("//Inter-Bold.ttf")
except:
    pass  # Use Blender's default BFont

# ── Logo Material — Metallic with Emission ──
mat_logo = bpy.data.materials.new("AvianceLogoMat")
mat_logo.use_nodes = True
nodes = mat_logo.node_tree.nodes
links = mat_logo.node_tree.links
nodes.clear()

# Output
node_output = nodes.new('ShaderNodeOutputMaterial')
node_output.location = (800, 0)

# Mix Shader (metallic + emission)
node_mix = nodes.new('ShaderNodeMixShader')
node_mix.location = (600, 0)
node_mix.inputs["Fac"].default_value = 0.3  # 30% emission blend

# Principled BSDF — cool metallic
node_bsdf = nodes.new('ShaderNodeBsdfPrincipled')
node_bsdf.location = (200, 100)
node_bsdf.inputs["Base Color"].default_value = (0.65, 0.72, 0.95, 1.0)  # Cool blue-white
node_bsdf.inputs["Metallic"].default_value = 0.95
node_bsdf.inputs["Roughness"].default_value = 0.15
node_bsdf.inputs["IOR"].default_value = 2.5

# Emission — electric blue glow
node_emission = nodes.new('ShaderNodeEmission')
node_emission.location = (200, -100)
node_emission.inputs["Color"].default_value = (0.35, 0.5, 1.0, 1.0)
node_emission.inputs["Strength"].default_value = 3.0

# Animate emission strength (pulse at formation)
node_emission.inputs["Strength"].keyframe_insert("default_value", frame=1)
node_emission.inputs["Strength"].default_value = 0.5
node_emission.inputs["Strength"].keyframe_insert("default_value", frame=60)
node_emission.inputs["Strength"].default_value = 8.0
node_emission.inputs["Strength"].keyframe_insert("default_value", frame=150)
node_emission.inputs["Strength"].default_value = 3.0
node_emission.inputs["Strength"].keyframe_insert("default_value", frame=200)

# Connect
links.new(node_bsdf.outputs["BSDF"], node_mix.inputs[1])
links.new(node_emission.outputs["Emission"], node_mix.inputs[2])
links.new(node_mix.outputs["Shader"], node_output.inputs["Surface"])

text_obj.data.materials.append(mat_logo)

# ── Text Animation — Scale reveal ──
text_obj.scale = (0.01, 0.01, 0.01)
text_obj.keyframe_insert(data_path="scale", frame=1)
text_obj.scale = (0.01, 0.01, 0.01)
text_obj.keyframe_insert(data_path="scale", frame=60)
text_obj.scale = (1.0, 1.0, 1.0)
text_obj.keyframe_insert(data_path="scale", frame=150)

# Set easing
for fcurve in text_obj.animation_data.action.fcurves:
    for keyframe in fcurve.keyframe_points:
        keyframe.interpolation = 'BEZIER'
        keyframe.easing = 'EASE_OUT'

# ═══════════════════════════════════════════════════
# 4. PARTICLE EMITTER — Converging particles
# ═══════════════════════════════════════════════════
bpy.ops.mesh.primitive_ico_sphere_add(
    radius=8, subdivisions=3, location=(0, 0, 0)
)
emitter = bpy.context.object
emitter.name = "ParticleEmitter"

# Particle system
bpy.ops.object.particle_system_add()
psys = emitter.particle_systems[0]
pset = psys.settings
pset.name = "LogoParticles"
pset.count = 2000
pset.frame_start = 1
pset.frame_end = 80
pset.lifetime = 300
pset.emit_from = 'FACE'
pset.physics_type = 'NEWTON'
pset.normal_factor = -3.0  # Particles fly inward
pset.factor_random = 1.5
pset.damping = 0.5
pset.particle_size = 0.02
pset.size_random = 0.5
pset.use_emit_random = True

# Particle material — small glowing spheres
mat_particle = bpy.data.materials.new("ParticleMat")
mat_particle.use_nodes = True
p_nodes = mat_particle.node_tree.nodes
p_links = mat_particle.node_tree.links
p_nodes.clear()

p_output = p_nodes.new('ShaderNodeOutputMaterial')
p_output.location = (400, 0)

p_emit = p_nodes.new('ShaderNodeEmission')
p_emit.location = (200, 0)
p_emit.inputs["Color"].default_value = (0.4, 0.55, 1.0, 1.0)
p_emit.inputs["Strength"].default_value = 5.0

p_links.new(p_emit.outputs["Emission"], p_output.inputs["Surface"])

# Hide emitter in render
emitter.hide_render = True

# Render particles as small spheres
pset.render_type = 'HALO'

# ═══════════════════════════════════════════════════
# 5. FLOATING DUST PARTICLES
# ═══════════════════════════════════════════════════
bpy.ops.mesh.primitive_cube_add(size=16, location=(0, 0, 0))
dust_emitter = bpy.context.object
dust_emitter.name = "DustEmitter"
dust_emitter.hide_render = True

bpy.ops.object.particle_system_add()
dust_psys = dust_emitter.particle_systems[0]
dust_pset = dust_psys.settings
dust_pset.name = "DustParticles"
dust_pset.count = 500
dust_pset.frame_start = 1
dust_pset.frame_end = 300
dust_pset.lifetime = 300
dust_pset.emit_from = 'VOLUME'
dust_pset.physics_type = 'NEWTON'
dust_pset.normal_factor = 0.0
dust_pset.factor_random = 0.3
dust_pset.brownian_factor = 0.5
dust_pset.damping = 0.9
dust_pset.particle_size = 0.005
dust_pset.size_random = 0.8
dust_pset.render_type = 'HALO'

# ═══════════════════════════════════════════════════
# 6. LIGHTING
# ═══════════════════════════════════════════════════

# Key light — cool blue area light from above-front
bpy.ops.object.light_add(type='AREA', location=(3, -4, 5))
key_light = bpy.context.object
key_light.name = "KeyLight"
key_light.data.energy = 500
key_light.data.color = (0.7, 0.8, 1.0)
key_light.data.size = 5
key_light.rotation_euler = (math.radians(45), 0, math.radians(20))

# Rim light — purple accent from behind
bpy.ops.object.light_add(type='AREA', location=(-3, 3, 3))
rim_light = bpy.context.object
rim_light.name = "RimLight"
rim_light.data.energy = 300
rim_light.data.color = (0.6, 0.3, 1.0)
rim_light.data.size = 4
rim_light.rotation_euler = (math.radians(-30), 0, math.radians(-160))

# Fill light — subtle warm from below
bpy.ops.object.light_add(type='POINT', location=(0, -2, -2))
fill_light = bpy.context.object
fill_light.name = "FillLight"
fill_light.data.energy = 100
fill_light.data.color = (1.0, 0.85, 0.7)

# Spotlight for dramatic cone
bpy.ops.object.light_add(type='SPOT', location=(0, -5, 4))
spot = bpy.context.object
spot.name = "SpotAccent"
spot.data.energy = 800
spot.data.color = (0.5, 0.6, 1.0)
spot.data.spot_size = math.radians(40)
spot.data.spot_blend = 0.5
spot.rotation_euler = (math.radians(50), 0, 0)

# Animate spot intensity
spot.data.energy = 0
spot.data.keyframe_insert("energy", frame=1)
spot.data.energy = 0
spot.data.keyframe_insert("energy", frame=80)
spot.data.energy = 800
spot.data.keyframe_insert("energy", frame=150)

# ═══════════════════════════════════════════════════
# 7. CAMERA
# ═══════════════════════════════════════════════════
bpy.ops.object.camera_add(location=(0, -8, 1))
camera = bpy.context.object
camera.name = "CinemaCamera"
camera.data.lens = 50
camera.data.dof.use_dof = True
camera.data.dof.focus_distance = 8.0
camera.data.dof.aperture_fstop = 2.8
scene.camera = camera

# Camera animation — slow dolly in with slight rotation
camera.location = (0, -12, 2)
camera.rotation_euler = (math.radians(80), 0, 0)
camera.keyframe_insert(data_path="location", frame=1)
camera.keyframe_insert(data_path="rotation_euler", frame=1)

camera.location = (0, -8, 0.8)
camera.rotation_euler = (math.radians(85), 0, 0)
camera.keyframe_insert(data_path="location", frame=180)
camera.keyframe_insert(data_path="rotation_euler", frame=180)

camera.location = (0.3, -7.5, 0.6)
camera.rotation_euler = (math.radians(86), math.radians(-1), 0)
camera.keyframe_insert(data_path="location", frame=300)
camera.keyframe_insert(data_path="rotation_euler", frame=300)

# Smooth camera curves
for fcurve in camera.animation_data.action.fcurves:
    for kf in fcurve.keyframe_points:
        kf.interpolation = 'BEZIER'
        kf.easing = 'EASE_IN_OUT'

# ═══════════════════════════════════════════════════
# 8. COMPOSITOR — Bloom / Glare
# ═══════════════════════════════════════════════════
scene.use_nodes = True
comp_nodes = scene.node_tree.nodes
comp_links = scene.node_tree.links
comp_nodes.clear()

node_rl = comp_nodes.new('CompositorNodeRLayers')
node_rl.location = (0, 0)

node_glare = comp_nodes.new('CompositorNodeGlare')
node_glare.location = (300, 0)
node_glare.glare_type = 'FOG_GLOW'
node_glare.quality = 'HIGH'
node_glare.mix = 0.0
node_glare.threshold = 0.8
node_glare.size = 7

node_cc = comp_nodes.new('CompositorNodeColorCorrection')
node_cc.location = (600, 0)
node_cc.master_saturation = 1.1
node_cc.master_gain = 1.05

node_comp = comp_nodes.new('CompositorNodeComposite')
node_comp.location = (900, 0)

comp_links.new(node_rl.outputs["Image"], node_glare.inputs["Image"])
comp_links.new(node_glare.outputs["Image"], node_cc.inputs["Image"])
comp_links.new(node_cc.outputs["Image"], node_comp.inputs["Image"])

# ═══════════════════════════════════════════════════
# 9. GROUND PLANE — reflective dark surface
# ═══════════════════════════════════════════════════
bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, -0.8))
ground = bpy.context.object
ground.name = "GroundPlane"

mat_ground = bpy.data.materials.new("GroundMat")
mat_ground.use_nodes = True
g_nodes = mat_ground.node_tree.nodes
g_links = mat_ground.node_tree.links
g_bsdf = g_nodes.get("Principled BSDF")
if g_bsdf:
    g_bsdf.inputs["Base Color"].default_value = (0.01, 0.012, 0.025, 1.0)
    g_bsdf.inputs["Metallic"].default_value = 0.9
    g_bsdf.inputs["Roughness"].default_value = 0.3
ground.data.materials.append(mat_ground)

print("=" * 50)
print("AVIANCE LOGO REVEAL — Scene Ready!")
print("=" * 50)
print("Hit Ctrl+F12 to render animation")
print(f"Output: {scene.render.filepath}")
print(f"Frames: {scene.frame_start}-{scene.frame_end} @ {scene.render.fps}fps")
print("=" * 50)
