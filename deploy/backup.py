"""Consistent local VPS backups. No secrets or customer data are printed."""
from pathlib import Path
import datetime, os, sqlite3

root=Path('/docker/synthamazon')
directory=root/'backups'
directory.mkdir(mode=0o700,exist_ok=True)
os.chmod(directory,0o700)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
target=directory/f'synthamazon-{stamp}.sqlite'
temporary=target.with_suffix('.partial')
source=sqlite3.connect(f'file:{root}/data/synthamazon.sqlite?mode=ro',uri=True,timeout=30)
output=sqlite3.connect(temporary)
os.chmod(temporary,0o600)
try:
    source.backup(output,pages=1024,sleep=0.1)
    assert output.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
finally:
    output.close();source.close()
temporary.replace(target)
# Only complete files made by this job, within this exact backup directory.
for old in sorted(directory.glob('synthamazon-????????T??????Z.sqlite'),reverse=True)[7:]:
    assert old.parent.resolve()==directory.resolve() and not old.is_symlink()
    old.unlink()
print('SynthAmazon backup verified')
