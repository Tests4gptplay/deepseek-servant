"""Package-owned, offline Python dependency selection for the resident helper.
No interpreter installation, pip, PATH changes, extraction or filesystem writes.
An unmatched ABI preserves the configured interpreter's original dependency path.
"""
from pathlib import Path
import importlib
import platform
import sys
import sysconfig


def activate():
    root = Path(__file__).resolve().parent / 'vendor'
    suffix = sysconfig.get_config_var('EXT_SUFFIX')
    if not suffix or sys.implementation.name != 'cpython':
        return 'configured-environment'
    # EXT_SUFFIX identifies interpreter ABI/CPU on Windows and Linux. macOS
    # uses the same suffix on both CPUs, so retain its wheel architecture tag.
    machine = platform.machine().lower()
    if machine == 'amd64': machine = 'x86_64'
    prefix = 'cp' + str(sys.version_info.major) + str(sys.version_info.minor) + '-'
    for variant in sorted((root / 'native').glob(prefix + '*')):
        if sys.platform == 'darwin' and not variant.name.endswith('_' + machine):
            continue
        native = variant / 'dulwich'
        if not all((native / (name + suffix)).is_file() for name in ('_pack', '_objects', '_diff_tree')):
            continue
        common = str(root / 'common')
        before = set(sys.modules)
        sys.path.insert(0, common)
        try:
            package = importlib.import_module('dulwich')
            package.__path__.insert(0, str(native))
            for name in ('_pack', '_objects', '_diff_tree'):
                importlib.import_module('dulwich.' + name)
            importlib.import_module('urllib3')
            return 'bundled-native'
        except (ImportError, OSError):
            # A platform loader may reject a wheel despite its suffix (e.g. an
            # older OS). Do not replace an already working user runtime with a
            # pure-Python fallback or change its global packages.
            for name in set(sys.modules) - before:
                if name == 'dulwich' or name.startswith('dulwich.') or name == 'urllib3' or name.startswith('urllib3.'):
                    del sys.modules[name]
            sys.path.remove(common)
            continue
    return 'configured-environment'
