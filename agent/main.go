// Sentinel Agent — authorized remote-administration client.
// Polls the server for commands, executes them locally, and posts results.
package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/kbinani/screenshot"
)

const defaultServer = "https://id-preview--05ec81ba-7df0-4619-a1e2-15d598c08860.lovable.app"

type config struct {
	Server      string `json:"server"`
	DeviceID    string `json:"device_id"`
	DeviceToken string `json:"device_token"`
}

type registerReq struct {
	EnrollmentCode string `json:"enrollment_code"`
	PCName         string `json:"pc_name"`
	DeviceName     string `json:"device_name"`
	OS             string `json:"os"`
	Username       string `json:"username"`
}
type registerResp struct {
	DeviceID    string `json:"device_id"`
	DeviceToken string `json:"device_token"`
	Error       string `json:"error"`
}

type metrics struct {
	UptimeSeconds int64 `json:"uptime_seconds"`
}

type heartbeatReq struct {
	DeviceID    string  `json:"device_id"`
	DeviceToken string  `json:"device_token"`
	Username    string  `json:"username,omitempty"`
	Metrics     metrics `json:"metrics"`
}

type pollReq struct {
	DeviceID    string `json:"device_id"`
	DeviceToken string `json:"device_token"`
}
type command struct {
	ID      string                 `json:"id"`
	Action  string                 `json:"action"`
	Payload map[string]interface{} `json:"payload"`
}
type pollResp struct {
	Commands []command `json:"commands"`
}

type resultReq struct {
	DeviceID    string      `json:"device_id"`
	DeviceToken string      `json:"device_token"`
	CommandID   string      `json:"command_id"`
	OK          bool        `json:"ok"`
	Result      interface{} `json:"result,omitempty"`
	Error       string      `json:"error,omitempty"`
}

type screenReq struct {
	DeviceID    string `json:"device_id"`
	DeviceToken string `json:"device_token"`
	JpegB64     string `json:"jpeg_b64"`
}

func configPath() string {
	exe, err := os.Executable()
	if err != nil {
		return "sentinel-agent.json"
	}
	return filepath.Join(filepath.Dir(exe), "sentinel-agent.json")
}

func loadConfig() (*config, error) {
	b, err := os.ReadFile(configPath())
	if err != nil {
		return nil, err
	}
	var c config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	return &c, nil
}
func saveConfig(c *config) error {
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(configPath(), b, 0600)
}
func hostname() string { h, _ := os.Hostname(); if h == "" { return "unknown-pc" }; return h }
func currentUser() string {
	u, err := user.Current()
	if err != nil {
		return os.Getenv("USERNAME")
	}
	n := u.Username
	if i := strings.LastIndex(n, `\`); i >= 0 {
		n = n[i+1:]
	}
	return n
}
func osName() string {
	switch runtime.GOOS {
	case "windows":
		return "Windows"
	case "darwin":
		return "macOS"
	default:
		return strings.Title(runtime.GOOS)
	}
}

var startedAt = time.Now()

func postJSON(url string, body interface{}, out interface{}) error {
	b, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "SentinelAgent/2.0")
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("server %d: %s", resp.StatusCode, string(raw))
	}
	if out != nil && len(raw) > 0 {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func register(server, code string) (*config, error) {
	var resp registerResp
	err := postJSON(server+"/api/public/agent/register", registerReq{
		EnrollmentCode: code, PCName: hostname(), DeviceName: hostname(),
		OS: osName(), Username: currentUser(),
	}, &resp)
	if err != nil {
		return nil, err
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("%s", resp.Error)
	}
	c := &config{Server: server, DeviceID: resp.DeviceID, DeviceToken: resp.DeviceToken}
	return c, saveConfig(c)
}

func heartbeat(c *config) error {
	return postJSON(c.Server+"/api/public/agent/heartbeat", heartbeatReq{
		DeviceID: c.DeviceID, DeviceToken: c.DeviceToken, Username: currentUser(),
		Metrics: metrics{UptimeSeconds: int64(time.Since(startedAt).Seconds())},
	}, nil)
}

func poll(c *config) ([]command, error) {
	var r pollResp
	err := postJSON(c.Server+"/api/public/agent/poll", pollReq{DeviceID: c.DeviceID, DeviceToken: c.DeviceToken}, &r)
	return r.Commands, err
}

func postResult(c *config, cmdID string, ok bool, result interface{}, errStr string) error {
	return postJSON(c.Server+"/api/public/agent/result", resultReq{
		DeviceID: c.DeviceID, DeviceToken: c.DeviceToken, CommandID: cmdID,
		OK: ok, Result: result, Error: errStr,
	}, nil)
}

func postScreen(c *config, b64 string) error {
	return postJSON(c.Server+"/api/public/agent/screen", screenReq{
		DeviceID: c.DeviceID, DeviceToken: c.DeviceToken, JpegB64: b64,
	}, nil)
}

// ---- handlers ----

func handleScreen(c *config, payload map[string]interface{}) (interface{}, error) {
	q := 60
	if v, ok := payload["quality"].(float64); ok && v >= 10 && v <= 95 {
		q = int(v)
	}
	n := screenshot.NumActiveDisplays()
	if n < 1 {
		return nil, fmt.Errorf("no displays")
	}
	img, err := screenshot.CaptureDisplay(0)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
		return nil, err
	}
	b64 := base64.StdEncoding.EncodeToString(buf.Bytes())
	if err := postScreen(c, b64); err != nil {
		return nil, err
	}
	return map[string]interface{}{"width": img.Bounds().Dx(), "height": img.Bounds().Dy(), "bytes": buf.Len()}, nil
}

func handleShell(payload map[string]interface{}) (interface{}, error) {
	cmdStr, _ := payload["cmd"].(string)
	if cmdStr == "" {
		return nil, fmt.Errorf("empty cmd")
	}
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.Command("cmd.exe", "/C", cmdStr)
	} else {
		c = exec.Command("sh", "-c", cmdStr)
	}
	var stdout, stderr bytes.Buffer
	c.Stdout = &stdout
	c.Stderr = &stderr
	err := c.Run()
	exit := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exit = ee.ExitCode()
		} else {
			exit = -1
		}
	}
	const max = 200_000
	out := stdout.String()
	errOut := stderr.String()
	if len(out) > max {
		out = out[:max] + "\n…[truncated]"
	}
	if len(errOut) > max {
		errOut = errOut[:max] + "\n…[truncated]"
	}
	return map[string]interface{}{"stdout": out, "stderr": errOut, "exit_code": exit}, nil
}

func handleFsList(payload map[string]interface{}) (interface{}, error) {
	p, _ := payload["path"].(string)
	if p == "" {
		p = "C:\\"
	}
	entries, err := os.ReadDir(p)
	if err != nil {
		return nil, err
	}
	out := []map[string]interface{}{}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, map[string]interface{}{
			"name":     e.Name(),
			"is_dir":   e.IsDir(),
			"size":     info.Size(),
			"modified": info.ModTime().Format(time.RFC3339),
		})
	}
	return map[string]interface{}{"path": p, "entries": out}, nil
}

func handleFsRead(payload map[string]interface{}) (interface{}, error) {
	p, _ := payload["path"].(string)
	if p == "" {
		return nil, fmt.Errorf("empty path")
	}
	info, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	if info.Size() > 5_000_000 {
		return nil, fmt.Errorf("file too large (max 5MB)")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"content": string(b), "size": len(b)}, nil
}

func handleFsDelete(payload map[string]interface{}) (interface{}, error) {
	p, _ := payload["path"].(string)
	if p == "" {
		return nil, fmt.Errorf("empty path")
	}
	if err := os.RemoveAll(p); err != nil {
		return nil, err
	}
	return map[string]interface{}{"deleted": p}, nil
}

func handleProcList() (interface{}, error) {
	if runtime.GOOS != "windows" {
		return map[string]interface{}{"processes": []interface{}{}}, nil
	}
	out, err := exec.Command("tasklist", "/fo", "csv", "/nh").Output()
	if err != nil {
		return nil, err
	}
	r := csv.NewReader(bytes.NewReader(out))
	r.FieldsPerRecord = -1
	procs := []map[string]interface{}{}
	for {
		rec, err := r.Read()
		if err != nil {
			break
		}
		if len(rec) < 5 {
			continue
		}
		pid, _ := strconv.Atoi(rec[1])
		memStr := strings.ReplaceAll(strings.ReplaceAll(rec[4], ",", ""), " K", "")
		memStr = strings.ReplaceAll(memStr, ".", "")
		kb, _ := strconv.ParseFloat(memStr, 64)
		procs = append(procs, map[string]interface{}{
			"pid":       pid,
			"name":      rec[0],
			"memory_mb": kb / 1024.0,
		})
	}
	return map[string]interface{}{"processes": procs}, nil
}

func handleProcKill(payload map[string]interface{}) (interface{}, error) {
	pidF, _ := payload["pid"].(float64)
	pid := int(pidF)
	if pid <= 0 {
		return nil, fmt.Errorf("invalid pid")
	}
	if runtime.GOOS == "windows" {
		out, err := exec.Command("taskkill", "/F", "/PID", strconv.Itoa(pid)).CombinedOutput()
		if err != nil {
			return nil, fmt.Errorf("%s: %s", err, string(out))
		}
	} else {
		if err := exec.Command("kill", "-9", strconv.Itoa(pid)).Run(); err != nil {
			return nil, err
		}
	}
	return map[string]interface{}{"killed": pid}, nil
}

func handleSystem(action string, payload map[string]interface{}) (interface{}, error) {
	switch action {
	case "system.shutdown":
		if runtime.GOOS == "windows" {
			return nil, exec.Command("shutdown", "/s", "/t", "5").Run()
		}
	case "system.restart":
		if runtime.GOOS == "windows" {
			return nil, exec.Command("shutdown", "/r", "/t", "5").Run()
		}
	case "system.lock":
		if runtime.GOOS == "windows" {
			return nil, exec.Command("rundll32.exe", "user32.dll,LockWorkStation").Run()
		}
	case "system.notify":
		msg, _ := payload["message"].(string)
		if runtime.GOOS == "windows" {
			return nil, exec.Command("msg", "*", "/TIME:10", msg).Run()
		}
	}
	return map[string]interface{}{"ok": true}, nil
}

func dispatch(c *config, cmd command) {
	var (
		res interface{}
		err error
	)
	switch cmd.Action {
	case "screen.capture":
		res, err = handleScreen(c, cmd.Payload)
	case "shell.exec":
		res, err = handleShell(cmd.Payload)
	case "fs.list":
		res, err = handleFsList(cmd.Payload)
	case "fs.read":
		res, err = handleFsRead(cmd.Payload)
	case "fs.delete":
		res, err = handleFsDelete(cmd.Payload)
	case "proc.list":
		res, err = handleProcList()
	case "proc.kill":
		res, err = handleProcKill(cmd.Payload)
	case "system.shutdown", "system.restart", "system.lock", "system.notify":
		res, err = handleSystem(cmd.Action, cmd.Payload)
	default:
		err = fmt.Errorf("unknown action: %s", cmd.Action)
	}
	if err != nil {
		_ = postResult(c, cmd.ID, false, nil, err.Error())
		fmt.Printf("[cmd %s %s] error: %s\n", cmd.ID[:8], cmd.Action, err)
	} else {
		_ = postResult(c, cmd.ID, true, res, "")
		fmt.Printf("[cmd %s %s] ok\n", cmd.ID[:8], cmd.Action)
	}
}

func prompt(label string) string {
	fmt.Print(label)
	r := bufio.NewReader(os.Stdin)
	s, _ := r.ReadString('\n')
	return strings.TrimSpace(s)
}

func main() {
	var (
		serverFlag = flag.String("server", "", "Server URL")
		codeFlag   = flag.String("code", "", "Enrollment code")
		resetFlag  = flag.Bool("reset", false, "Discard saved config")
	)
	flag.Parse()
	if *resetFlag {
		os.Remove(configPath())
		fmt.Println("Config cleared.")
	}

	fmt.Println("Sentinel Agent v2 — authorized remote administration")
	fmt.Println("Host:", hostname(), "| OS:", osName(), "| User:", currentUser())

	cfg, err := loadConfig()
	if err != nil {
		server := strings.TrimRight(*serverFlag, "/")
		if server == "" {
			server = defaultServer
		}
		code := strings.TrimSpace(*codeFlag)
		if code == "" {
			code = prompt("Enter enrollment code: ")
		}
		if code == "" {
			fmt.Println("No enrollment code. Exit.")
			os.Exit(1)
		}
		fmt.Println("Registering with", server)
		cfg, err = register(server, code)
		if err != nil {
			fmt.Println("Registration failed:", err)
			os.Exit(1)
		}
		fmt.Println("Registered. Device:", cfg.DeviceID)
	} else {
		fmt.Println("Loaded config. Device:", cfg.DeviceID)
	}

	// Heartbeat goroutine
	go func() {
		_ = heartbeat(cfg)
		t := time.NewTicker(10 * time.Second)
		for range t.C {
			if err := heartbeat(cfg); err != nil {
				fmt.Println("heartbeat err:", err)
			}
		}
	}()

	// Command polling loop
	fmt.Println("Polling for commands. Ctrl+C to stop.")
	for {
		cmds, err := poll(cfg)
		if err != nil {
			fmt.Println("poll err:", err)
			time.Sleep(3 * time.Second)
			continue
		}
		for _, cmd := range cmds {
			go dispatch(cfg, cmd)
		}
		sleep := 800 * time.Millisecond
		if len(cmds) > 0 {
			sleep = 200 * time.Millisecond
		}
		time.Sleep(sleep)
	}
}
