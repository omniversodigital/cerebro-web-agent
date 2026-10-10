import os
import sys
import json
import time
import argparse
import base64
from io import BytesIO
from PIL import Image, ImageDraw

# Add current directory to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv()

from storage import storage
from ai_fallback_router import router as ai_router

try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    sync_playwright = None
    PLAYWRIGHT_AVAILABLE = False

try:
    from google import genai
    from google.genai import types
    GENAI_AVAILABLE = True
except ImportError:
    genai = None
    types = None
    GENAI_AVAILABLE = False


def sanitize_prompt_input(input_text: str) -> str:
    """Sanitize input text to prevent Indirect Prompt Injection attacks."""
    if not input_text:
        return ""
    # Neutralize prompt override signatures
    forbidden_patterns = [
        "ignore previous instructions", "ignore all instructions",
        "system prompt:", "you are now a", "override instructions",
        "eval(", "<script", "javascript:"
    ]
    sanitized = str(input_text)
    for pattern in forbidden_patterns:
        if pattern in sanitized.lower():
            sanitized = sanitized.replace(pattern, f"[NEUTRALIZED_PATTERN: {pattern}]")
    return sanitized.strip()


def parse_args():
    parser = argparse.ArgumentParser(description="Gemini Computer Use Agent")
    parser.add_argument("--task", type=str, required=True, help="Automation task/instruction")
    parser.add_argument("--url", type=str, default="https://www.google.com", help="Initial starting URL")
    parser.add_argument("--api-key", type=str, default=None, help="Gemini API Key")
    parser.add_argument("--sim", action="store_true", default=False, help="Run in simulation mode")
    parser.add_argument("--run-id", type=str, required=True, help="Unique run ID for logging and assets")
    args = parser.parse_args()
    args.task = sanitize_prompt_input(args.task)
    return args


def output_step(step_idx, status, screenshot_path, action_type=None, coords=None, text_typed=None, explanation="", run_id="default"):
    """Output step details as structured JSON line and persist atomically to SQLite DB."""
    # Save to Relational SQLite DB
    try:
        storage.append_computer_history(
            run_id=run_id,
            step_idx=step_idx,
            action_type=action_type or "unknown",
            coords=coords,
            text_typed=text_typed,
            explanation=explanation,
            screenshot_path=screenshot_path
        )
    except Exception as db_err:
        print(f"[SQLite Log Warning]: {db_err}", file=sys.stderr)

    print(json.dumps({
        "type": "step",
        "step": step_idx,
        "status": status,
        "screenshot": screenshot_path,
        "action": action_type,
        "coords": coords,
        "text": text_typed,
        "explanation": explanation
    }), flush=True)


def draw_visual_overlay(image_path, action_type, coords=None, text_typed=None):
    """Draw a visual overlay (red dot/circle and action label) on the screenshot for dashboard presentation."""
    try:
        img = Image.open(image_path)
        draw = ImageDraw.Draw(img)
        
        if coords and len(coords) == 2:
            x, y = coords[0], coords[1]
            # Draw a outer glowing ring
            draw.ellipse([x - 15, y - 15, x + 15, y + 15], outline="rgba(255, 0, 0, 128)", width=3)
            # Draw an inner red dot
            draw.ellipse([x - 5, y - 5, x + 5, y + 5], fill="red")
            
            # Action text
            label = f"{action_type.upper()}"
            if text_typed:
                label += f": '{text_typed}'"
            draw.text((x + 18, y - 8), label, fill="red")
            
        overlay_path = image_path.replace(".png", "_overlay.png")
        img.save(overlay_path)
        return overlay_path
    except Exception as e:
        # Fallback to original if drawing fails
        return image_path


def run_simulation(args):
    """Execute a highly interactive, simulated browser automation scenario."""
    run_dir = os.path.join("public", "runs", args.run_id)
    os.makedirs(run_dir, exist_ok=True)
    
    print(json.dumps({"type": "info", "message": f"Starting simulation mode for task: {args.task}"}), flush=True)
    
    # Pre-defined simulation workflows based on task keywords
    task_lower = args.task.lower()
    
    steps = []
    if "wikipedia" in task_lower or "wiki" in task_lower:
        steps = [
            {
                "url": "https://www.wikipedia.org",
                "action": "navigate",
                "coords": None,
                "text": None,
                "explanation": "Navigating to Wikipedia home page"
            },
            {
                "url": "https://www.wikipedia.org",
                "action": "type",
                "coords": [450, 340],
                "text": "Artificial Intelligence",
                "explanation": "Locating Wikipedia search bar and typing search query 'Artificial Intelligence'"
            },
            {
                "url": "https://www.wikipedia.org",
                "action": "click",
                "coords": [670, 340],
                "text": None,
                "explanation": "Clicking search submit button to search for 'Artificial Intelligence'"
            },
            {
                "url": "https://en.wikipedia.org/wiki/Artificial_intelligence",
                "action": "scroll",
                "coords": [512, 384],
                "text": "down",
                "explanation": "Scrolling down the Wikipedia article to find historical sections"
            },
            {
                "url": "https://en.wikipedia.org/wiki/Artificial_intelligence",
                "action": "click",
                "coords": [220, 520],
                "text": None,
                "explanation": "Clicking on the 'History' subsection link in the table of contents"
            }
        ]
    elif "flight" in task_lower or "travel" in task_lower or "nyc" in task_lower:
        steps = [
            {
                "url": "https://www.google.com/travel/flights",
                "action": "navigate",
                "coords": None,
                "text": None,
                "explanation": "Opening flight search portal"
            },
            {
                "url": "https://www.google.com/travel/flights",
                "action": "type",
                "coords": [320, 240],
                "text": "New York (NYC)",
                "explanation": "Setting origin location to New York City (NYC)"
            },
            {
                "url": "https://www.google.com/travel/flights",
                "action": "type",
                "coords": [550, 240],
                "text": "London (LHR)",
                "explanation": "Setting destination location to London Heathrow (LHR)"
            },
            {
                "url": "https://www.google.com/travel/flights",
                "action": "click",
                "coords": [780, 240],
                "text": None,
                "explanation": "Clicking on search button to find available flights"
            },
            {
                "url": "https://www.google.com/travel/flights",
                "action": "scroll",
                "coords": [512, 384],
                "text": "down",
                "explanation": "Scrolling through search results to locate the cheapest flight schedule"
            }
        ]
    elif any(x in task_lower for x in ["news", "article", "latest", "headline"]):
        steps = [
            {
                "url": "https://news.ycombinator.com",
                "action": "navigate",
                "coords": None,
                "text": None,
                "explanation": "Navigating to Hacker News homepage"
            },
            {
                "url": "https://news.ycombinator.com",
                "action": "click",
                "coords": [120, 10],
                "text": None,
                "explanation": "Clicking on the 'new' tab to show recent submissions"
            },
            {
                "url": "https://news.ycombinator.com/newest",
                "action": "scroll",
                "coords": [512, 384],
                "text": "down",
                "explanation": "Scrolling down through latest headlines to scan articles"
            },
            {
                "url": "https://news.ycombinator.com/newest",
                "action": "click",
                "coords": [250, 150],
                "text": None,
                "explanation": "Clicking the first article link to read content"
            }
        ]
    elif any(x in task_lower for x in ["price", "shop", "buy", "product", "store"]):
        steps = [
            {
                "url": "https://www.ebay.com",
                "action": "navigate",
                "coords": None,
                "text": None,
                "explanation": "Navigating to eBay shopping homepage"
            },
            {
                "url": "https://www.ebay.com",
                "action": "type",
                "coords": [350, 40],
                "text": "Bluetooth Headphones",
                "explanation": "Typing product query 'Bluetooth Headphones' in the search bar"
            },
            {
                "url": "https://www.ebay.com",
                "action": "click",
                "coords": [800, 40],
                "text": None,
                "explanation": "Clicking search submit button to search for products"
            },
            {
                "url": "https://www.ebay.com/sch/i.html",
                "action": "scroll",
                "coords": [512, 384],
                "text": "down",
                "explanation": "Scrolling down page to view product listings and compare deals"
            }
        ]
    elif any(x in task_lower for x in ["form", "contact", "submit", "register", "feedback"]):
        steps = [
            {
                "url": "https://example.com",
                "action": "navigate",
                "coords": None,
                "text": None,
                "explanation": "Navigating to feedback portal"
            },
            {
                "url": "https://example.com",
                "action": "type",
                "coords": [400, 250],
                "text": "Developer Agent",
                "explanation": "Locating input field and typing user name 'Developer Agent'"
            },
            {
                "url": "https://example.com",
                "action": "type",
                "coords": [400, 310],
                "text": "agent@cerebro.ai",
                "explanation": "Typing contact email address 'agent@cerebro.ai'"
            },
            {
                "url": "https://example.com",
                "action": "type",
                "coords": [400, 390],
                "text": "Gemini Computer Use visualizer playground successfully deployed.",
                "explanation": "Entering feedback message into description textbox"
            },
            {
                "url": "https://example.com",
                "action": "click",
                "coords": [450, 460],
                "text": None,
                "explanation": "Clicking submit button to dispatch feedback payload"
            }
        ]
    else:
        # Default scenario (Google search)
        steps = [
            {
                "url": "https://www.google.com",
                "action": "navigate",
                "coords": None,
                "text": None,
                "explanation": "Opening Google search engine home page"
            },
            {
                "url": "https://www.google.com",
                "action": "type",
                "coords": [480, 310],
                "text": args.task,
                "explanation": f"Clicking into Google search box and typing: '{args.task}'"
            },
            {
                "url": "https://www.google.com",
                "action": "click",
                "coords": [580, 410],
                "text": None,
                "explanation": "Clicking the 'Google Search' button to fetch results"
            },
            {
                "url": "https://www.google.com/search",
                "action": "scroll",
                "coords": [512, 384],
                "text": "down",
                "explanation": "Scrolling down the search results list to examine matching entries"
            },
            {
                "url": "https://www.google.com/search",
                "action": "click",
                "coords": [250, 180],
                "text": None,
                "explanation": "Clicking on the first organic result link to read more content"
            }
        ]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"])
        page = browser.new_page(viewport={"width": 1024, "height": 768})
        
        current_url = args.url
        for idx, step in enumerate(steps):
            step_num = idx + 1
            print(json.dumps({"type": "info", "message": f"Running step {step_num}: {step['explanation']}"}), flush=True)
            
            # Navigate if needed or goto the step url if not loaded
            if step["action"] == "navigate":
                current_url = step["url"]
                try:
                    page.goto(current_url, timeout=30000)
                    page.wait_for_timeout(2000)
                except Exception as ex:
                    print(json.dumps({"type": "info", "message": f"Navigation failed (simulated path fallback): {ex}"}), flush=True)
            else:
                # We can perform the action on the real page to make the screenshot authentic!
                try:
                    if step["action"] == "click":
                        page.mouse.click(step["coords"][0], step["coords"][1])
                        page.wait_for_timeout(1500)
                    elif step["action"] == "type":
                        page.mouse.click(step["coords"][0], step["coords"][1])
                        page.keyboard.type(step["text"])
                        page.wait_for_timeout(1000)
                    elif step["action"] == "scroll":
                        page.mouse.wheel(0, 400 if step["text"] == "down" else -400)
                        page.wait_for_timeout(1500)
                except Exception as ex:
                    # In case playwright action fails (e.g. element not clickable at coordinate), ignore and keep going since it is simulation
                    pass
            
            # Save screenshot
            screenshot_fn = f"step_{step_num}.png"
            screenshot_path = os.path.join(run_dir, screenshot_fn)
            try:
                page.screenshot(path=screenshot_path)
            except Exception:
                # Fallback blank image if playwright screenshot fails
                img = Image.new("RGB", (1024, 768), color="#1e1e2e")
                img.save(screenshot_path)
                
            # Draw visual overlay on it
            overlay_rel_path = f"runs/{args.run_id}/step_{step_num}_overlay.png"
            draw_visual_overlay(screenshot_path, step["action"], step["coords"], step["text"])
            
            # Output step JSON
            output_step(
                step_idx=step_num,
                status="completed",
                screenshot_path=overlay_rel_path,
                action_type=step["action"],
                coords=step["coords"],
                text_typed=step["text"],
                explanation=step["explanation"]
            )
            time.sleep(2)  # Pause for visual tracking
            
        # Compile final summary
        print(json.dumps({
            "type": "result",
            "status": "success",
            "message": f"Simulation completed successfully. Visualized {len(steps)} actions of browser automation.",
            "report": f"### Simulation Report\n\n- **Target Task:** {args.task}\n- **Environment:** Browser Simulator (Playwright Chromium)\n- **Steps Visualized:** {len(steps)}\n\n#### Key Actions Taken:\n" + "\n".join([f"{i+1}. **{s['action'].upper()}** at `{s['coords'] or 'N/A'}`: {s['explanation']}" for i, s in enumerate(steps)])
        }), flush=True)
        
        browser.close()


def run_live_agent(args):
    """Execute actual Gemini Computer Use look-think-act loop."""
    run_dir = os.path.join("public", "runs", args.run_id)
    os.makedirs(run_dir, exist_ok=True)
    
    api_key = args.api_key or os.getenv("GEMINI_API_KEY")
    if not api_key:
        print(json.dumps({"type": "error", "message": "Gemini API Key is required for Live Mode."}))
        sys.exit(1)
        
    client = genai.Client(api_key=api_key)
    
    print(json.dumps({"type": "info", "message": f"Initializing live Gemini Computer Use agent. Task: {args.task}"}), flush=True)
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"])
        # Resize viewport to 1024x768
        page = browser.new_page(viewport={"width": 1024, "height": 768})
        
        print(json.dumps({"type": "info", "message": f"Navigating to initial URL: {args.url}"}), flush=True)
        try:
            page.goto(args.url, timeout=30000)
            page.wait_for_timeout(2000)
        except Exception as e:
            print(json.dumps({"type": "error", "message": f"Failed to navigate to starting URL: {e}"}))
            browser.close()
            sys.exit(1)
            
        step_num = 1
        max_steps = 15
        
        # We start the interaction with the model
        # Using generate_content loop with computer use tool
        conversation_history = [
            types.Content(
                role="user",
                parts=[types.Part.from_text(text=f"Please automate this task in the browser environment: {args.task}. The viewport is 1024x768. The current page has been opened for you.")]
            )
        ]
        
        while step_num <= max_steps:
            # 1. Capture current browser viewport screenshot
            screenshot_path = os.path.join(run_dir, f"step_{step_num}_raw.png")
            page.screenshot(path=screenshot_path)
            
            # Read screenshot as PIL Image for API input
            pil_img = Image.open(screenshot_path)
            
            # Add the screenshot to the history for the model to see the current state
            conversation_history.append(
                types.Content(
                    role="user",
                    parts=[
                        types.Part(value=pil_img),
                        types.Part.from_text(text="This is the current screenshot of the browser. What action should we take next?")
                    ]
                )
            )
            
            print(json.dumps({"type": "info", "message": f"Step {step_num}: Querying Gemini 3.5 Flash..."}), flush=True)
            
            try:
                # Call generate_content with computer_use tool configured
                response = client.models.generate_content(
                    model="gemini-3.5-flash",
                    contents=conversation_history,
                    config=types.GenerateContentConfig(
                        tools=[types.Tool(computer_use=types.ComputerUse(environment=types.Environment.ENVIRONMENT_BROWSER))]
                    )
                )
            except Exception as e:
                print(json.dumps({"type": "error", "message": f"Gemini API Call Failed: {e}"}))
                break
                
            # Add assistant's response to conversation history
            conversation_history.append(response.candidates[0].content)
            
            # Analyze parts to look for tool/function calls
            function_call = None
            thought_text = ""
            
            for part in response.candidates[0].content.parts:
                if part.thought:
                    thought_text += part.text if part.text else ""
                if part.function_call:
                    function_call = part.function_call
                    
            if not function_call:
                # No more action requested, agent compiled response or finished
                report_text = response.text if response.text else "Automation finished."
                print(json.dumps({
                    "type": "result",
                    "status": "success",
                    "message": "Gemini finished automation task.",
                    "report": report_text
                }), flush=True)
                break
                
            # Parse function call name and args
            action_name = function_call.name
            args_dict = function_call.args or {}
            
            # Mapping action_name (typically from standard computer use tool spec)
            # Typically: "mouse_move", "left_click", "type", "key", "scroll", etc.
            action_type = "unknown"
            coords = None
            text_typed = None
            explanation = thought_text or f"Executing action {action_name}"
            
            try:
                if "click" in action_name or action_name == "left_click":
                    action_type = "click"
                    coords = args_dict.get("coordinate", [0, 0])
                    page.mouse.click(coords[0], coords[1])
                    explanation = f"Clicking at coordinate {coords}"
                elif "type" in action_name:
                    action_type = "type"
                    coords = args_dict.get("coordinate", [0, 0])
                    text_typed = args_dict.get("text", "")
                    # Click first
                    page.mouse.click(coords[0], coords[1])
                    page.keyboard.type(text_typed)
                    explanation = f"Typing '{text_typed}' at coordinate {coords}"
                elif "scroll" in action_name:
                    action_type = "scroll"
                    scroll_dir = args_dict.get("direction", "down")
                    text_typed = scroll_dir
                    page.mouse.wheel(0, 400 if scroll_dir == "down" else -400)
                    explanation = f"Scrolling {scroll_dir}"
                elif "move" in action_name or action_name == "mouse_move":
                    action_type = "move"
                    coords = args_dict.get("coordinate", [0, 0])
                    page.mouse.move(coords[0], coords[1])
                    explanation = f"Moving cursor to coordinate {coords}"
                elif "key" in action_name:
                    action_type = "key"
                    key_val = args_dict.get("key", "enter")
                    text_typed = key_val
                    page.keyboard.press(key_val)
                    explanation = f"Pressing key '{key_val}'"
                else:
                    explanation = f"Unknown tool call action: {action_name}"
                    
                # Save screenshot after action
                screenshot_fn = f"step_{step_num}.png"
                screenshot_path = os.path.join(run_dir, screenshot_fn)
                page.wait_for_timeout(1000)
                page.screenshot(path=screenshot_path)
                
                # Draw visual overlay on it
                overlay_rel_path = f"runs/{args.run_id}/step_{step_num}_overlay.png"
                draw_visual_overlay(screenshot_path, action_type, coords, text_typed)
                
                # Output step JSON
                output_step(
                    step_idx=step_num,
                    status="completed",
                    screenshot_path=overlay_rel_path,
                    action_type=action_type,
                    coords=coords,
                    text_typed=text_typed,
                    explanation=explanation
                )
                
                # Feed function response back to the client
                function_response = types.Part.from_function_response(
                    name=action_name,
                    response={"success": True}
                )
                conversation_history.append(
                    types.Content(
                        role="user",
                        parts=[function_response]
                    )
                )
                
            except Exception as action_err:
                err_msg = f"Failed to execute {action_name}: {action_err}"
                print(json.dumps({"type": "info", "message": err_msg}), flush=True)
                
                # Feed error response back to model
                function_response = types.Part.from_function_response(
                    name=action_name,
                    response={"success": False, "error": str(action_err)}
                )
                conversation_history.append(
                    types.Content(
                        role="user",
                        parts=[function_response]
                    )
                )
                
            step_num += 1
            time.sleep(2)
            
        else:
            print(json.dumps({
                "type": "result",
                "status": "failed",
                "message": "Max execution steps reached without conclusion."
            }), flush=True)
            
        browser.close()


def main():
    args = parse_args()
    if args.sim:
        run_simulation(args)
    else:
        run_live_agent(args)


if __name__ == "__main__":
    main()
