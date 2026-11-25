export LOCAL_SOURCE := home_directory() / '.local/share/skillshare-sources/understand-anything'

[doc('Publish the committed plugin at HEAD to the local Skillshare source')]
[group('publish')]
[script('python3')]
publish-local:
    import os
    import subprocess
    from pathlib import Path
    from tempfile import TemporaryDirectory

    destination = Path(os.environ['LOCAL_SOURCE'])
    with TemporaryDirectory() as temp:
        archive = Path(temp) / 'plugin.tar'
        snapshot = Path(temp) / 'snapshot'
        snapshot.mkdir()
        subprocess.run(['git', 'archive', '-o', archive, 'HEAD', '.claude-plugin', 'understand-anything-plugin'], check=True)
        subprocess.run(['tar', '-xf', archive, '-C', snapshot], check=True)
        destination.mkdir(parents=True, exist_ok=True)
        subprocess.run(['rsync', '-a', '--delete', f'{snapshot}/', destination], check=True)
    print(f'Published to {destination}')
