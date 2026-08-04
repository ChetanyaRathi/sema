# Brand + editor icon assets, generated from assets/icons/svg/.
# Imported UNnamespaced (`jake icons-assets`, `jake brand-assets`).

# Renders assets/icons/png/ at every needed size and overwrites the consumer
# copies (website + playground favicons/logos/avatars, the crate's Windows
# executable icon). Run after editing any SVG in assets/icons/svg/.
@group icons
@desc "Render assets/icons/png + sync every consumer copy"
@needs rsvg-convert "brew install librsvg"
task icons-assets:
    ./scripts/gen-icon-assets.py

# The website /icons showcase can't import from the repo root (Vercel uploads
# only website/), so the SVGs are inlined into a JS module instead.
@group icons
@desc "Regenerate website brandAssets.js from the canonical icon SVGs"
task brand-assets:
    ./scripts/gen-brand-assets.py
