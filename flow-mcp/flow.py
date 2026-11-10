"""flow: CLI for Google Flow's own backend (see README.md). Prints JSON.

  flow.py credits
  flow.py models
  flow.py projects [--limit 20] [--page TOKEN]
  flow.py create-project "Title"
  flow.py rename-project PROJECT "Title"
  flow.py media PROJECT
  flow.py get PROJECT MEDIA
  flow.py wait PROJECT MEDIA [--timeout 900]
  flow.py download PROJECT MEDIA PATH
  flow.py upload PROJECT FILE
  flow.py image PROJECT "prompt" [--model "Nano Banana Pro"] [--aspect 16:9] [--count 1] [--quality High] [--ref MEDIA ...]
  flow.py video PROJECT "prompt" [--model "Omni 1.1 Flash"] [--aspect 16:9] [--seconds 4] [--resolution 360p] [--count 1]
                [--ref MEDIA ...] [--start MEDIA] [--end MEDIA]
  flow.py upscale PROJECT MEDIA TARGET PATH      (TARGET e.g. 720p, 1080p, 4K: as the media's Download menu offers)
  flow.py edit PROJECT MEDIA "instruction"       (Omni video edit, costs credits)
  flow.py assets PROJECT                         (preset voices, avatars)
  flow.py characters|scenes|collections PROJECT
  flow.py make-character PROJECT "Name" IMAGE_MEDIA [--body MEDIA] [--personality "..."] [--voice achird]
  flow.py update-character PROJECT CHARACTER [--name --personality --voice]
  flow.py character-image PROJECT CHARACTER MEDIA [--slot portrait|body]
  flow.py new-scene PROJECT ["Title"] | rename-scene PROJECT SCENE "Title"
  flow.py new-collection PROJECT "Title" | rename-collection PROJECT COLLECTION "Title"
  flow.py rename-media PROJECT MEDIA "Title" | favorite PROJECT MEDIA [--off] | cover PROJECT MEDIA
  flow.py proxy-stop
"""
import argparse, json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from flowapi import Flow, FlowError
import proxy


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog='flow', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('credits'); sub.add_parser('models'); sub.add_parser('proxy-stop')
    p = sub.add_parser('projects'); p.add_argument('--limit', type=int, default=20); p.add_argument('--page')
    p = sub.add_parser('create-project'); p.add_argument('title')
    p = sub.add_parser('rename-project'); p.add_argument('project'); p.add_argument('title')
    p = sub.add_parser('media'); p.add_argument('project')
    for name in ('get', 'wait'):
        p = sub.add_parser(name); p.add_argument('project'); p.add_argument('media')
        if name == 'wait':
            p.add_argument('--timeout', type=float, default=900)
    p = sub.add_parser('download'); p.add_argument('project'); p.add_argument('media'); p.add_argument('path')
    p = sub.add_parser('upload'); p.add_argument('project'); p.add_argument('file')
    p = sub.add_parser('upscale'); p.add_argument('project'); p.add_argument('media'); p.add_argument('target'); p.add_argument('path')
    p = sub.add_parser('edit'); p.add_argument('project'); p.add_argument('media'); p.add_argument('instruction')
    p.add_argument('--max-credits', type=int); p.add_argument('--dry-run', action='store_true')
    p = sub.add_parser('extend'); p.add_argument('project'); p.add_argument('media'); p.add_argument('prompt')
    p.add_argument('--seconds', type=int, default=4); p.add_argument('--max-credits', type=int)
    p.add_argument('--dry-run', action='store_true')
    p = sub.add_parser('scene-clip'); p.add_argument('project'); p.add_argument('scene'); p.add_argument('media')
    p.add_argument('--position', type=int, default=0)
    p = sub.add_parser('assets'); p.add_argument('project')
    for name in ('characters', 'scenes', 'collections'):
        p = sub.add_parser(name); p.add_argument('project')
    p = sub.add_parser('make-character'); p.add_argument('project'); p.add_argument('name'); p.add_argument('image')
    p.add_argument('--body'); p.add_argument('--personality'); p.add_argument('--voice')
    p = sub.add_parser('update-character'); p.add_argument('project'); p.add_argument('character')
    p.add_argument('--name'); p.add_argument('--personality'); p.add_argument('--voice')
    p = sub.add_parser('character-image'); p.add_argument('project'); p.add_argument('character'); p.add_argument('media')
    p.add_argument('--slot', default='portrait', choices=['portrait', 'body'])
    p = sub.add_parser('new-scene'); p.add_argument('project'); p.add_argument('title', nargs='?')
    p = sub.add_parser('rename-scene'); p.add_argument('project'); p.add_argument('scene'); p.add_argument('title')
    p = sub.add_parser('new-collection'); p.add_argument('project'); p.add_argument('title')
    p = sub.add_parser('rename-collection'); p.add_argument('project'); p.add_argument('collection'); p.add_argument('title')
    p = sub.add_parser('rename-media'); p.add_argument('project'); p.add_argument('media'); p.add_argument('title')
    p = sub.add_parser('favorite'); p.add_argument('project'); p.add_argument('media'); p.add_argument('--off', action='store_true')
    p = sub.add_parser('cover'); p.add_argument('project'); p.add_argument('media')
    for name in ('image', 'video'):
        p = sub.add_parser(name); p.add_argument('project'); p.add_argument('prompt')
        p.add_argument('--model'); p.add_argument('--aspect', default='16:9'); p.add_argument('--count', type=int, default=1)
        p.add_argument('--ref', action='append', default=[]); p.add_argument('--no-wait', action='store_true')
        if name == 'image':
            p.add_argument('--quality')
        else:
            p.add_argument('--seconds', type=int); p.add_argument('--resolution'); p.add_argument('--start'); p.add_argument('--end')
            p.add_argument('--max-credits', type=int); p.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(argv)
    if a.cmd == 'proxy-stop':
        proxy.stop(); print(json.dumps({'stopped': True})); return 0
    f = Flow()
    try:
        r = {'credits': lambda: f.credits(),
             'models': lambda: f.models(),
             'projects': lambda: f.list_projects(a.limit, a.page),
             'create-project': lambda: f.create_project(a.title),
             'rename-project': lambda: f.rename_project(a.project, a.title),
             'media': lambda: f.list_media(a.project),
             'get': lambda: f.get_media(a.project, a.media),
             'wait': lambda: f.wait_media(a.project, a.media, a.timeout),
             'download': lambda: f.download(a.project, a.media, a.path),
             'upload': lambda: f.upload_ingredient(a.project, a.file),
             'upscale': lambda: f.upscale(a.project, a.media, a.target, a.path),
             'edit': lambda: f.edit_video(a.project, a.media, a.instruction, max_credits=a.max_credits, dry_run=a.dry_run),
             'extend': lambda: f.extend_video(a.project, a.media, a.prompt, a.seconds, max_credits=a.max_credits, dry_run=a.dry_run),
             'scene-clip': lambda: f.add_scene_clip(a.project, a.scene, a.media, a.position),
             'assets': lambda: f.project_assets(a.project),
             'characters': lambda: f.list_characters(a.project),
             'scenes': lambda: f.list_scenes(a.project),
             'collections': lambda: f.list_collections(a.project),
             'make-character': lambda: f.create_character(a.project, a.name, a.image, a.body, a.personality, a.voice),
             'update-character': lambda: f.update_character(a.project, a.character, a.name, a.personality, a.voice),
             'character-image': lambda: f.set_character_image(a.project, a.character, a.media, a.slot),
             'new-scene': lambda: f.create_scene(a.project, a.title),
             'rename-scene': lambda: f.rename_scene(a.project, a.scene, a.title),
             'new-collection': lambda: f.create_collection(a.project, a.title),
             'rename-collection': lambda: f.rename_collection(a.project, a.collection, a.title),
             'rename-media': lambda: f.rename_media(a.project, a.media, a.title),
             'favorite': lambda: f.favorite_media(a.project, a.media, not a.off),
             'cover': lambda: f.set_project_cover(a.project, a.media),
             'image': lambda: f.generate(a.project, a.prompt, 'image', a.model, a.aspect, a.count, quality=a.quality,
                                         references=a.ref, wait=not a.no_wait),
             'video': lambda: f.generate(a.project, a.prompt, 'video', a.model, a.aspect, a.count, resolution=a.resolution,
                                         seconds=a.seconds, references=a.ref, start_frame=a.start, end_frame=a.end,
                                         wait=not a.no_wait, max_credits=a.max_credits,
                                         dry_run=getattr(a, 'dry_run', False))}[a.cmd]()
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return 0
    except FlowError as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False)); return 1
    finally:
        f.close()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
