
import { ImageMagick, initialize, MagickFormat } from "https://deno.land/x/imagemagick_deno@0.0.31/mod.ts";
import { walk } from "jsr:@std/fs";
import { join, extname } from "jsr:@std/path";

const TARGET_WIDTH = 1920;
const IMAGES_DIR = join(Deno.cwd(), "src/assets/images");

async function optimizeImages() {
  console.log(`🔍 Scanning for images in ${IMAGES_DIR}...`);

  await initialize(); // Initialize WASM

  try {
    const stats = await Deno.stat(IMAGES_DIR);
    if (!stats.isDirectory) {
      console.error(`❌ ${IMAGES_DIR} is not a directory.`);
      Deno.exit(1);
    }
  } catch (e) {
    console.error(`❌ Directory ${IMAGES_DIR} not found. Make sure you've moved images to src/assets/images first.`);
    Deno.exit(1);
  }

  const entries = walk(IMAGES_DIR, {
    includeDirs: false,
    exts: ["jpg", "jpeg", "png", "webp"],
  });

  let count = 0;

  for await (const entry of entries) {
    count++;
    try {
      const fileContent = await Deno.readFile(entry.path);

      await ImageMagick.read(fileContent, async (img) => {
        let changed = false;

        // Resize if too large
        if (img.width > TARGET_WIDTH) {
          console.log(`📉 Resizing ${entry.name} from ${img.width}px to ${TARGET_WIDTH}px`);
          img.resize(TARGET_WIDTH, 0); // 0 = maintain aspect ratio
          changed = true;
        }

        if (changed) {
          // Determine format from extension or keep original logic
          // simpler to just write back with same format detection or explicitly
          // ImageMagick usually handles write format based on content or we can specify (defaults to original usually?)
          // API: write(func: (data: Uint8Array) => void | Promise<void>): Promise<void>;
          // It writes in the format of the image.

          await img.write(async (data) => {
            await Deno.writeFile(entry.path, data);
            console.log(`✅ Updated ${entry.name}`);
          });
        }
      });

    } catch (e) {
      console.error(`❌ Failed to process ${entry.name}:`, e);
    }
  }

  if (count === 0) {
    console.log("No images found.");
  } else {
    console.log(`✨ Image optimization complete! Scanned ${count} images.`);
  }
}

if (import.meta.main) {
  optimizeImages();
}
