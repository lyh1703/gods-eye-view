# B11-094 Matrix-3D | ARGUS synthetic-scene bounded receiver

Source: https://github.com/SkyworkAI/Matrix-3D, pinned source SHA `3f32ef8c7de41da8ef378ec3eed32d970d73d214`.

## Actual retained ability
The new `src/scenes/matrix3dSyntheticPly.js` checks a real provided `.ply` file's header, format, bounded vertex count and SHA-256 against a source-pinned manifest. Successful output is **always synthetic**. It cannot enter ARGUS observed geography/map-information layers and cannot be confused with satellite imagery or RF sensor truth.

## Actual limitations
No Matrix-3D model inference, output rendering or VRAM benchmark was run. The reference upstream supports 5B low-VRAM mode starting around 12GB GPU VRAM and recommends CUDA/Linux. The current known i7/32GB Windows laptop does not establish the required NVIDIA GPU. Do not purchase cloud GPU or download gigabytes of third-party models just for this receipt. The upstream MIT code README/NOTICE references individually licensed Gaussian-splatting/nvdiffrast/StableSR/VEnhancer components; rights are not presumed blanket-MIT by the parent README. Local personal/noncommercial R&D may proceed with individually licensed assets.

Result: synthetic PLY receipt code/fixture tests, not live navigable full 3D scene playback or independently source-cleared transfer. No change to ARGUS live provider network, geolocation or billing.
