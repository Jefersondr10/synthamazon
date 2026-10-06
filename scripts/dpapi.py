"""Windows DPAPI CurrentUser bridge. Sensitive bytes travel only over stdio."""

import ctypes
from ctypes import wintypes
import os
import sys


MAX_INPUT_BYTES = 1024 * 1024
CRYPTPROTECT_UI_FORBIDDEN = 0x1


class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(wintypes.BYTE)),
    ]


def transform(data, protect):
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    blob_pointer = ctypes.POINTER(DATA_BLOB)
    crypt32.CryptProtectData.argtypes = [
        blob_pointer, wintypes.LPCWSTR, blob_pointer,
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, blob_pointer,
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [
        blob_pointer, ctypes.POINTER(wintypes.LPWSTR), blob_pointer,
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, blob_pointer,
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p

    buffer = ctypes.create_string_buffer(data, len(data))
    input_blob = DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(wintypes.BYTE)))
    output_blob = DATA_BLOB()
    operation = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    try:
        # Omitting CRYPTPROTECT_LOCAL_MACHINE binds the blob to the current user.
        success = operation(
            ctypes.byref(input_blob), None, None, None, None,
            CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(output_blob),
        )
        if not success or not output_blob.pbData:
            raise RuntimeError("Protected operation failed")
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        ctypes.memset(buffer, 0, len(data))
        if output_blob.pbData:
            ctypes.memset(output_blob.pbData, 0, output_blob.cbData)
            kernel32.LocalFree(ctypes.cast(output_blob.pbData, ctypes.c_void_p))


def main():
    if os.name != "nt" or len(sys.argv) != 3 or sys.argv[1] != "--mode" or sys.argv[2] not in ("protect", "unprotect"):
        raise ValueError("Invalid operation")
    content = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if not content or len(content) > MAX_INPUT_BYTES:
        raise ValueError("Invalid input")
    if sys.argv[2] == "protect":
        output = transform(content, True).hex().encode("ascii")
    else:
        output = transform(bytes.fromhex(content.decode("ascii").strip()), False)
    if not output or len(output) > MAX_INPUT_BYTES:
        raise ValueError("Invalid output")
    sys.stdout.buffer.write(output)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("Protected credentials operation failed.")
        sys.exit(1)
