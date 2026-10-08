"""Run with python3 -m unittest discover -s test -p backup_test.py."""
from contextlib import closing, redirect_stdout
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
import io
import os
import sqlite3
import tempfile
import unittest

spec = spec_from_file_location('synthamazon_backup', Path(__file__).resolve().parents[1] / 'deploy' / 'backup.py')
backup = module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='synthamazon-backup-test-')
        self.root = Path(self.temporary.name)
        (self.root / 'data').mkdir()
        self.source = sqlite3.connect(self.root / 'data' / 'synthamazon.sqlite', isolation_level=None, timeout=0.1)
        self.source.execute('PRAGMA journal_mode=WAL')
        self.source.executescript('CREATE TABLE state(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);'
                                  'INSERT INTO state VALUES(1,0),(2,0);'
                                  'CREATE TABLE payload(id INTEGER PRIMARY KEY,body TEXT NOT NULL);')
        self.source.execute('BEGIN')
        self.source.executemany('INSERT INTO payload VALUES(?,?)', ((index, 'x' * 4000) for index in range(200)))
        self.source.execute('COMMIT')
        self.stdout = io.StringIO()
        self.redirect = redirect_stdout(self.stdout)
        self.redirect.__enter__()

    def tearDown(self):
        self.redirect.__exit__(None, None, None)
        self.source.close()
        self.temporary.cleanup()

    def run_backup(self, **kwargs):
        return backup.create_backup(self.root, stamp='20261008T063000Z', **kwargs)

    def complete(self):
        return sorted((self.root / 'backups').glob('synthamazon-*.sqlite'))

    def assert_no_partial(self):
        self.assertFalse(list((self.root / 'backups').glob('*.partial*')))

    def test_paced_snapshot_completes_while_every_batch_has_external_commits(self):
        writes = []

        def change_live_database(delay):
            self.assertGreater(delay, 0)
            self.source.execute('BEGIN IMMEDIATE')
            self.source.execute('UPDATE state SET value=value+1')
            self.source.execute('COMMIT')
            writes.append(delay)

        with mock.patch.object(backup.time, 'sleep', side_effect=change_live_database):
            target = self.run_backup(pages=2, pause_seconds=0.01)
        self.assertGreater(len(writes), 10, 'the live database was written between many copy batches')
        self.assertGreater(self.source.execute('SELECT value FROM state LIMIT 1').fetchone()[0], 10)
        with closing(sqlite3.connect(target)) as copied:
            self.assertEqual(copied.execute('SELECT value FROM state ORDER BY id').fetchall(), [(0,), (0,)])
            self.assertEqual(copied.execute('SELECT count(*) FROM payload').fetchone(), (200,))
            self.assertEqual(copied.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
            self.assertEqual(copied.execute('PRAGMA journal_mode').fetchone(), ('delete',))
        self.assertEqual(self.source.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0], 0,
                         'the source snapshot has been released')
        self.assert_no_partial()
        self.assertFalse(target.with_name(target.name + '-wal').exists())
        if os.name != 'nt':
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_timeout_during_copy_does_not_publish_or_prune(self):
        previous = backup.create_backup(self.root, pause_seconds=0, stamp='20261007T063000Z')
        previous_bytes = previous.read_bytes()
        clock = [0.0]
        with mock.patch.object(backup.time, 'monotonic', side_effect=lambda: clock[0]), \
             mock.patch.object(backup.time, 'sleep', side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)):
            with self.assertRaises(backup.BackupTimeout):
                self.run_backup(max_seconds=0.01, pages=1, pause_seconds=0.1)
        self.assertEqual(self.complete(), [previous])
        self.assertEqual(previous.read_bytes(), previous_bytes)
        self.assert_no_partial()

    def test_failed_verification_preserves_all_prior_backups_and_old_partial(self):
        directory = self.root / 'backups'
        directory.mkdir()
        for day in range(1, 8):
            (directory / f'synthamazon-202610{day:02}T063000Z.sqlite').write_bytes(b'previous complete backup')
        old_partial = directory / 'synthamazon-20260930T063000Z.partial'
        old_partial.write_bytes(b'previous interrupted attempt')
        before = {item.name: item.read_bytes() for item in directory.iterdir()}
        with mock.patch.object(backup, 'verify_backup', side_effect=backup.BackupFailure('test failure')):
            with self.assertRaises(backup.BackupFailure):
                self.run_backup(pause_seconds=0)
        self.assertEqual(len(self.complete()), 7)
        self.assertEqual({item.name: item.read_bytes() for item in directory.iterdir() if item.name != '.backup.lock'}, before)

    def test_success_keeps_seven_complete_files_and_does_not_touch_other_files(self):
        directory = self.root / 'backups'
        directory.mkdir()
        for day in range(1, 9):
            (directory / f'synthamazon-202609{day:02}T063000Z.sqlite').write_bytes(b'old complete')
        unrelated = directory / 'manual-copy.sqlite'
        unrelated.write_bytes(b'manual')
        partial = directory / 'synthamazon-20261001T063000Z.partial'
        partial.write_bytes(b'partial')
        target = self.run_backup(pause_seconds=0)
        complete = self.complete()
        self.assertEqual(len(complete), 7)
        self.assertIn(target, complete)
        self.assertEqual(complete[0].name, 'synthamazon-20260903T063000Z.sqlite')
        self.assertEqual(unrelated.read_bytes(), b'manual')
        self.assertEqual(partial.read_bytes(), b'partial')

    def test_validation_is_also_bounded(self):
        budget = backup.Budget(10)
        budget.ends_at = 0
        with self.assertRaises(backup.BackupTimeout):
            backup.verify_backup(self.source, budget)

    def test_low_disk_space_fails_without_a_partial_or_completed_file(self):
        with mock.patch.object(backup.shutil, 'disk_usage', return_value=SimpleNamespace(free=0)):
            with self.assertRaisesRegex(backup.BackupFailure, 'disk space'):
                self.run_backup(pause_seconds=0)
        self.assertEqual(self.complete(), [])
        self.assert_no_partial()

    def test_overlapping_invocation_is_rejected_and_lock_is_reusable(self):
        directory = self.root / 'backups'
        directory.mkdir()
        with backup.backup_lock(directory):
            with self.assertRaises(OSError):
                self.run_backup(pause_seconds=0)
        target = self.run_backup(pause_seconds=0)
        self.assertTrue(target.exists())

    def test_existing_completed_backup_cannot_be_replaced(self):
        target = self.run_backup(pause_seconds=0)
        original = target.read_bytes()
        self.source.execute('UPDATE state SET value=99')
        with self.assertRaises(backup.BackupFailure):
            self.run_backup(pause_seconds=0)
        self.assertEqual(target.read_bytes(), original)
        self.assert_no_partial()


if __name__ == '__main__':
    unittest.main()
