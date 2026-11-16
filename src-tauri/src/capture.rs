// Windows: grabs part of the screen (for snips) with GDI. macOS uses the
// system's own screencapture tool instead (see ai.rs).

/// The screen area in physical pixels, as width and height (u32, little
/// endian) followed by RGBA pixels, top row first.
#[cfg(windows)]
pub fn grab(x: i32, y: i32, width: i32, height: i32) -> Result<Vec<u8>, String> {
    use windows::Win32::Graphics::Gdi::*;
    if width <= 0 || height <= 0 {
        return Err("The screen has no size.".into());
    }
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("The screen couldn't be captured.".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let old = SelectObject(mem, bitmap.into());
        let copied = BitBlt(mem, 0, 0, width, height, Some(screen), x, y, SRCCOPY | CAPTUREBLT);
        SelectObject(mem, old);

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // top row first
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut out = vec![0u8; 8 + (width as usize) * (height as usize) * 4];
        let lines = GetDIBits(mem, bitmap, 0, height as u32, Some(out[8..].as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if copied.is_err() || lines != height {
            return Err("The screen couldn't be captured.".into());
        }
        out[0..4].copy_from_slice(&(width as u32).to_le_bytes());
        out[4..8].copy_from_slice(&(height as u32).to_le_bytes());
        // GDI gives BGRA with no alpha; the page wants opaque RGBA
        for px in out[8..].chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        Ok(out)
    }
}
