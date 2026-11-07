"""flow-mcp: MCP server (stdio) for Google Flow's own backend. See README.md.

One headless Chrome session (gflow's saved login) lives in a single worker thread; every tool runs there.
Rule: everything for one video lives in ONE project, so every media tool takes project_id.
"""
import asyncio, atexit, concurrent.futures, os, pathlib, sys, threading
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mcp.server.mcpserver import MCPServer
from flowapi import Flow
import config
import proxy

_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix='flow')
_flow: Flow | None = None
_timer: threading.Timer | None = None
IDLE_S = float(config.get('idle_close_s', 'FLOW_IDLE_CLOSE_S', 180))  # free the shared Chrome profile when idle


def _idle_close():
    _pool.submit(lambda: _flow and _flow.close())


def _call(fn_name: str, *args):
    global _flow, _timer
    if _timer:
        _timer.cancel()
    if _flow is None:
        _flow = Flow()
    try:
        return getattr(_flow, fn_name)(*args)
    finally:
        _timer = threading.Timer(IDLE_S, _idle_close)
        _timer.daemon = True
        _timer.start()


async def run(fn_name: str, *args):
    return await asyncio.wrap_future(_pool.submit(_call, fn_name, *args))


def _shutdown():
    if _flow is not None:
        try:
            _pool.submit(_flow.close).result(timeout=30)
        except RuntimeError:  # pool already shut down at interpreter exit; Chrome exits with us
            pass
    proxy.stop()  # the private xray this server started (none if it reused a running one)


atexit.register(_shutdown)

mcp = MCPServer('flow', instructions=(
    'Google Flow (flow.google.com) through its own backend. Put ALL media of one video in ONE project: '
    'create it once (flow_create_project) and pass its id to every call. Check credits before and after any '
    'video. Images are free; video costs credits (see flow_models).'))


@mcp.tool()
async def flow_credits() -> dict:
    """Current Flow credit balance."""
    return await run('credits')


@mcp.tool()
async def flow_models() -> dict:
    """Live model catalog from Flow: video model keys with seconds and credit cost, image models, and the
    model families enabled on this account. New models (e.g. Omni 1.2) appear here when Google enables them."""
    return await run('models')


@mcp.tool()
async def flow_list_projects(limit: int = 20, page_token: str | None = None) -> dict:
    """List Flow projects, newest first. Pass next_page_token to get the next page."""
    return await run('list_projects', limit, page_token)


@mcp.tool()
async def flow_create_project(title: str) -> dict:
    """Create one project (one per video). Returns its id."""
    return await run('create_project', title)


@mcp.tool()
async def flow_rename_project(project_id: str, title: str) -> dict:
    """Rename a project."""
    return await run('rename_project', project_id, title)


@mcp.tool()
async def flow_list_media(project_id: str) -> list:
    """All images, videos and uploads in a project: media_id, kind, model, status, prompt, created."""
    return await run('list_media', project_id)


@mcp.tool()
async def flow_get_media(project_id: str, media_id: str) -> dict:
    """One media item with its status (submitted/running/done) and signed download URL when done."""
    return await run('get_media', project_id, media_id)


@mcp.tool()
async def flow_wait_media(project_id: str, media_id: str, timeout_s: float = 900) -> dict:
    """Poll a generation until it is done or failed (or the timeout passes)."""
    return await run('wait_media', project_id, media_id, timeout_s)


@mcp.tool()
async def flow_download(project_id: str, media_id: str, path: str) -> dict:
    """Download a finished image or video to path (a file path, or a folder)."""
    return await run('download', project_id, media_id, path)


@mcp.tool()
async def flow_upload_ingredient(project_id: str, file: str) -> dict:
    """Upload a local reference image into the project (Flow's own upload). Returns its media_id."""
    return await run('upload_ingredient', project_id, file)


@mcp.tool()
async def flow_generate_image(project_id: str, prompt: str, model: str | None = None, aspect: str = '16:9',
                              count: int = 1, quality: str | None = None, references: list[str] | None = None,
                              wait: bool = True) -> dict:
    """Generate images in a project with Flow's direct composer (Flow's agent is switched off).
    model: a family name from flow_models image list, e.g. "Nano Banana Pro", "Nano Banana 2.1", "Nano Banana 2 Lite".
    aspect: 16:9, 4:3, 1:1, 3:4 or 9:16. count: 1-4. quality: Low, Medium or High (when the model offers it).
    references: media ids already in this project (upload files first with flow_upload_ingredient).
    Images cost 0 credits. Returns the new media (ids, status, dims, signed URL), the submit's real model key,
    and credits before/after. Download with flow_download."""
    return await run('generate', project_id, prompt, 'image', model, aspect, count, quality, None, None,
                     references or [], None, None, wait)


@mcp.tool()
async def flow_generate_video(project_id: str, prompt: str, model: str | None = None, aspect: str = '16:9',
                              seconds: int | None = None, resolution: str | None = None, count: int = 1,
                              references: list[str] | None = None, start_frame: str | None = None,
                              end_frame: str | None = None, wait: bool = True, timeout_s: float = 1200,
                              max_credits: int | None = None) -> dict:
    """Generate videos in a project with Flow's direct composer (agent off). SPENDS CREDITS: check flow_models
    for the cost of each model key and flow_credits first.
    model: video family from flow_models, e.g. "Omni 1.2 Flash" (key macaron_cookie, 3-15 s), "Omni 1.1 Flash", "Veo 3.1 - Lite", "Veo 3.1 - Fast", "Veo 3.1 - Quality".
    aspect: 16:9 or 9:16. seconds: 4, 6, 8 or 10; Omni 1.2 also 3-15 (as the model offers). resolution: 360p or 720p (Omni).
    count: 1-4 (each one is billed). references: project media ids as ingredients (Ingredients mode).
    start_frame / end_frame: project media ids (Frames mode; references are then ignored by Flow).
    Omni 1.2 uses a Length slider: any whole number 3-15 works. max_credits: refuse (submit nothing) if Flow's own
    "Generating will use N credits" line is higher. Returns new media with status, planned_credits, the submit's
    real model key (e.g. abra_t2v_4s_360p) and credits spent."""
    return await run('generate', project_id, prompt, 'video', model, aspect, count, None, resolution, seconds,
                     references or [], start_frame, end_frame, wait, timeout_s, max_credits)


@mcp.tool()
async def flow_upscale(project_id: str, media_id: str, target: str, path: str) -> dict:
    """Upscale a finished video through its media page's Download menu and save the file to path.
    target: what the menu offers for that clip, e.g. "720p" for an Omni 360p clip, "1080p" or "4K" for 720p clips.
    Cost per flow_models: Omni 360p->720p and Veo 1080p upsamplers 0 credits, Veo 4K 50."""
    return await run('upscale', project_id, media_id, target, path)


@mcp.tool()
async def flow_edit_video(project_id: str, media_id: str, instruction: str, wait: bool = True,
                          max_credits: int | None = None) -> dict:
    """Edit an existing video with Omni ("Describe how to edit this video"), e.g. change a color, remove an object.
    SPENDS CREDITS (flow_models: abra_edit 20, abra_edit_360p 10). Returns the new media and credits before/after."""
    return await run('edit_video', project_id, media_id, instruction, wait, 1200, max_credits)


@mcp.tool()
async def flow_project_assets(project_id: str) -> dict:
    """Preset voices (id, name, description, sample URL) and avatars Flow offers in a project."""
    return await run('project_assets', project_id)


@mcp.tool()
async def flow_list_characters(project_id: str) -> list:
    """Characters of a project: id, name, voice id, personality, portrait/body workflow ids, portrait media id."""
    return await run('list_characters', project_id)


@mcp.tool()
async def flow_create_character(project_id: str, name: str, image_media_id: str, body_media_id: str | None = None,
                                personality: str | None = None, voice: str | None = None) -> dict:
    """Create a character from images ALREADY in the project (the user's own photos: upload with flow_upload_ingredient
    first, then pass the media id). image_media_id = portrait, body_media_id = optional full-body image.
    personality: free text the Flow agent reads. voice: preset voice id from flow_project_assets (e.g. "achird").
    Free (0 credits), no generation. Use the character in the Flow agent / scenes; Flow copies the images."""
    return await run('create_character', project_id, name, image_media_id, body_media_id, personality, voice)


@mcp.tool()
async def flow_update_character(project_id: str, character_id: str, name: str | None = None,
                                personality: str | None = None, voice: str | None = None) -> dict:
    """Change a character's name, personality notes and/or preset voice id."""
    return await run('update_character', project_id, character_id, name, personality, voice)


@mcp.tool()
async def flow_set_character_image(project_id: str, character_id: str, media_id: str, slot: str = 'portrait') -> dict:
    """Set a character's portrait (slot "portrait") or full body (slot "body") from an image already in the project."""
    return await run('set_character_image', project_id, character_id, media_id, slot)


@mcp.tool()
async def flow_list_scenes(project_id: str) -> list:
    """Scenes (timelines) of a project: id, title, created, updated (the listing does not carry the clips)."""
    return await run('list_scenes', project_id)


@mcp.tool()
async def flow_create_scene(project_id: str, title: str | None = None) -> dict:
    """Create an empty scene (timeline) in a project, optionally titled. Adding clips is not available through the API yet."""
    return await run('create_scene', project_id, title)


@mcp.tool()
async def flow_rename_scene(project_id: str, scene_id: str, title: str) -> dict:
    """Rename a scene."""
    return await run('rename_scene', project_id, scene_id, title)


@mcp.tool()
async def flow_add_scene_clip(project_id: str, scene_id: str, media_id: str, position: int = 0) -> dict:
    """Add a video already in the project to a scene's timeline. Free (Flow copies the video as a clip)."""
    return await run('add_scene_clip', project_id, scene_id, media_id, position)


@mcp.tool()
async def flow_extend_video(project_id: str, media_id: str, prompt: str, seconds: int = 4, wait: bool = True,
                            max_credits: int | None = None) -> dict:
    """Extend a video with Omni ("Add clip" -> "Extend", prompt = what happens next, seconds 3-10).
    SPENDS CREDITS: set max_credits; the tool refuses before submitting if Flow's own price line is higher."""
    return await run('extend_video', project_id, media_id, prompt, seconds, wait, 1200, max_credits)


@mcp.tool()
async def flow_list_collections(project_id: str) -> list:
    """Library collections of a project: id, title."""
    return await run('list_collections', project_id)


@mcp.tool()
async def flow_create_collection(project_id: str, title: str) -> dict:
    """Create a library collection in a project."""
    return await run('create_collection', project_id, title)


@mcp.tool()
async def flow_rename_collection(project_id: str, collection_id: str, title: str) -> dict:
    """Rename a library collection."""
    return await run('rename_collection', project_id, collection_id, title)


@mcp.tool()
async def flow_rename_media(project_id: str, media_id: str, title: str) -> dict:
    """Give an image/video a display title."""
    return await run('rename_media', project_id, media_id, title)


@mcp.tool()
async def flow_favorite_media(project_id: str, media_id: str, favorite: bool = True) -> dict:
    """Mark or unmark an image/video as favorite."""
    return await run('favorite_media', project_id, media_id, favorite)


@mcp.tool()
async def flow_set_project_cover(project_id: str, media_id: str) -> dict:
    """Use an image or video of the project as the project cover."""
    return await run('set_project_cover', project_id, media_id)


if __name__ == '__main__':
    mcp.run('stdio')
