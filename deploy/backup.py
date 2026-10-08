"""Bounded, paced WAL snapshots. Never print database contents or publish partials.

Daily quick_check verifies database structure in linear time. It intentionally
does not replace a separate full integrity_check audit of index consistency.
"""
from contextlib import closing, contextmanager
from pathlib import Path
import datetime
import os
import re
import shutil
import signal
import sqlite3
import sys
import tempfile
import time

ROOT = Path('/docker/synthamazon')
COMPLETE = re.compile(r'synthamazon-\d{8}T\d{6}Z\.sqlite')
RESERVE_BYTES = 256 * 1024 * 1024
MAX_WAL_GROWTH = 512 * 1024 * 1024


class BackupFailure(RuntimeError):
    pass


class BackupTimeout(BackupFailure):
    pass


class Budget:
    def __init__(self, seconds):
        self.ends_at = time.monotonic() + seconds

    def expired(self):
        return time.monotonic() >= self.ends_at

    def check(self):
        if self.expired():
            raise BackupTimeout('Backup exceeded its time budget')


@contextmanager
def backup_lock(directory):
    """A kernel lock also prevents overlapping manual invocations; no stale PID."""
    lock_path = directory / '.backup.lock'
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(descriptor, 'a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            lock.write(b'0')
            lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Closing releases the lock. Keep its file to avoid unlink/reopen races.
        yield


def fsync_directory(directory):
    if os.name != 'nt':
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def verify_backup(output, budget):
    # The deadline also covers validation, rather than just the copying loop.
    output.set_progress_handler(lambda: int(budget.expired()), 10_000)
    try:
        if output.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise BackupFailure('Backup structural verification failed')
    except sqlite3.OperationalError:
        budget.check()
        raise
    finally:
        output.set_progress_handler(None, 0)
    budget.check()


def prune_complete(directory, keep):
    # Partials, unrelated files and symlinks are never retention candidates.
    complete = sorted((item for item in directory.iterdir()
                       if COMPLETE.fullmatch(item.name) and item.is_file()
                       and not item.is_symlink()), reverse=True)
    for old in complete[keep:]:
        if old.parent.resolve() != directory.resolve() or old.is_symlink():
            raise BackupFailure('Unsafe retention path')
        old.unlink()


def create_backup(root=ROOT, *, max_seconds=25 * 60, pages=256,
                  pause_seconds=0.05, keep=7, stamp=None):
    if max_seconds <= 0 or pages < 1 or pause_seconds < 0 or keep < 1:
        raise ValueError('Invalid backup limits')
    budget = Budget(max_seconds)
    root = Path(root).resolve()
    source_path = root / 'data' / 'synthamazon.sqlite'
    directory = root / 'backups'
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    stamp = stamp or datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    if not re.fullmatch(r'\d{8}T\d{6}Z', stamp):
        raise ValueError('Invalid backup timestamp')
    target = directory / f'synthamazon-{stamp}.sqlite'
    with backup_lock(directory):
        if target.exists() or target.is_symlink():
            raise BackupFailure('A completed backup already has this timestamp')
        descriptor, filename = tempfile.mkstemp(prefix=f'.synthamazon-{stamp}-', suffix='.partial', dir=directory)
        os.close(descriptor)
        temporary = Path(filename)
        os.chmod(temporary, 0o600)
        try:
            with closing(sqlite3.connect(temporary, timeout=2, isolation_level=None)) as output:
                output.execute('PRAGMA cache_size=-16384')
                with closing(sqlite3.connect(f'{source_path.as_uri()}?mode=ro', uri=True,
                                             timeout=2, isolation_level=None)) as source:
                    source.execute('PRAGMA cache_size=-16384')
                    if source.execute('PRAGMA journal_mode').fetchone()[0].lower() != 'wal':
                        raise BackupFailure('Online snapshots require WAL mode')
                    # Pin a committed WAL snapshot so writes on other connections
                    # cannot restart every chunk. WAL writers remain unblocked.
                    source.execute('BEGIN')
                    source.execute('SELECT rootpage FROM sqlite_schema LIMIT 1').fetchall()
                    page_count = source.execute('PRAGMA page_count').fetchone()[0]
                    page_size = source.execute('PRAGMA page_size').fetchone()[0]
                    if shutil.disk_usage(directory).free < page_count * page_size + RESERVE_BYTES:
                        raise BackupFailure('Insufficient disk space for a safe snapshot')
                    wal_path = Path(f'{source_path}-wal')
                    wal_start = wal_path.stat().st_size if wal_path.exists() else 0
                    last_disk_check = time.monotonic()

                    def progress(status, remaining, total):
                        nonlocal last_disk_check
                        budget.check()
                        current = time.monotonic()
                        if current - last_disk_check >= 5:
                            last_disk_check = current
                            wal_size = wal_path.stat().st_size if wal_path.exists() else 0
                            if shutil.disk_usage(directory).free < RESERVE_BYTES or wal_size - wal_start > MAX_WAL_GROWTH:
                                raise BackupFailure('Snapshot disk or WAL growth limit reached')
                        # sqlite3.backup(sleep=...) sleeps only for BUSY/LOCKED.
                        # Explicit pacing on successful chunks limits normal I/O.
                        if status == sqlite3.SQLITE_OK and remaining:
                            time.sleep(min(pause_seconds, max(0, budget.ends_at - current)))
                        budget.check()

                    print('SynthAmazon backup: copying committed snapshot', flush=True)
                    source.backup(output, pages=pages, progress=progress, sleep=0.1)
                    source.rollback()
                # Release the source snapshot before validation so WAL can shrink.
                budget.check()
                output.execute('PRAGMA journal_mode=DELETE')
                print('SynthAmazon backup: verifying snapshot structure', flush=True)
                verify_backup(output, budget)
            with temporary.open('r+b') as snapshot:
                os.fsync(snapshot.fileno())
            budget.check()
            temporary.replace(target)
            fsync_directory(directory)
            # Existing good backups are removed only after a new good one exists.
            prune_complete(directory, keep)
            print('SynthAmazon backup verified', flush=True)
            return target
        finally:
            # Delete only this invocation's temporary output, including SQLite
            # sidecars. Older interrupted jobs and completed files are untouched.
            for suffix in ('', '-journal', '-wal', '-shm'):
                Path(f'{temporary}{suffix}').unlink(missing_ok=True)


def main():
    def cancelled(_signal, _frame):
        raise BackupFailure('Backup stopped')

    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    if hasattr(os, 'setpriority'):
        os.setpriority(os.PRIO_PROCESS, 0, 19)
    try:
        create_backup()
    except Exception as error:
        # Do not put imported data or SQLite error contents in the journal.
        print(f'SynthAmazon backup failed ({type(error).__name__}); completed backups preserved', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
