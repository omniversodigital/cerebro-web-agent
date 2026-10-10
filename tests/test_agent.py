import os
import sys
import pytest
from PIL import Image

# Ensure the project directory is on the path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent import draw_visual_overlay, parse_args

def test_visual_overlay(tmp_path):
    # Create a mock base image
    img_path = os.path.join(tmp_path, "mock_step.png")
    img = Image.new("RGB", (200, 200), color="#121214")
    img.save(img_path)
    
    # Test drawing overlay
    overlay_path = draw_visual_overlay(img_path, "click", [100, 100], "Target Element")
    
    assert os.path.exists(overlay_path)
    assert overlay_path.endswith("_overlay.png")
    
    # Ensure overlay image size is preserved
    overlay_img = Image.open(overlay_path)
    assert overlay_img.size == (200, 200)

def test_arg_parser():
    # Save original command line arguments
    original_argv = sys.argv
    try:
        # Simulate CLI arguments
        sys.argv = [
            "agent.py",
            "--task", "Check flight rates from London to Milan",
            "--run-id", "test_run_xyz",
            "--sim"
        ]
        args = parse_args()
        assert args.task == "Check flight rates from London to Milan"
        assert args.run_id == "test_run_xyz"
        assert args.sim is True
        assert args.url == "https://www.google.com" # default
    finally:
        sys.argv = original_argv
