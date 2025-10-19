package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func must(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fmt.Fprintln(os.Stderr, k+" not set")
		os.Exit(1)
	}
	return v
}
func mustMaybe(k string) string { return os.Getenv(k) }

func httpJSON(method, u, ua, auth string, body io.Reader) (*http.Response, error) {
	req, _ := http.NewRequest(method, u, body)
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept", "application/json")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	c := &http.Client{Timeout: 30 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	if !(resp.StatusCode >= 200 && resp.StatusCode < 300) || !strings.Contains(resp.Header.Get("Content-Type"), "application/json") {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		return nil, fmt.Errorf("%s %d %s %q", u, resp.StatusCode, resp.Header.Get("Content-Type"), string(b))
	}
	return resp, nil
}

func token(id, secret, ua string) (string, error) {
	user := mustMaybe("REDDIT_USERNAME")
	pass := mustMaybe("REDDIT_PASSWORD")
	form := url.Values{}
	form.Set("scope", "read")
	if user != "" && pass != "" {
		form.Set("grant_type", "password")
		form.Set("username", user)
		form.Set("password", pass)
	} else {
		form.Set("grant_type", "client_credentials")
	}
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte(id+":"+secret))
	resp, err := httpJSON("POST", "https://www.reddit.com/api/v1/access_token", ua, auth, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var tr struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return "", err
	}
	if tr.AccessToken == "" {
		return "", fmt.Errorf("empty access_token")
	}
	return tr.AccessToken, nil
}

func getS(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
func getB(v any) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return false
}

type fp struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Subreddit         string `json:"subreddit"`
	Author            string `json:"author"`
	IsSelf            bool   `json:"is_self"`
	Domain            string `json:"domain"`
	Title             string `json:"title"`
	SelftextHTML      string `json:"selftext_html"`
	Selftext          string `json:"selftext"`
	URL               string `json:"url"`
	Permalink         string `json:"permalink"`
	Edited            any    `json:"edited"`
	Over18            bool   `json:"over_18"`
	Spoiler           bool   `json:"spoiler"`
	Locked            bool   `json:"locked"`
	Stickied          bool   `json:"stickied"`
	LinkFlairText     string `json:"link_flair_text"`
	LinkFlairCSSClass string `json:"link_flair_css_class"`
}

func subsetHash(raw json.RawMessage) (string, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", err
	}
	g := fp{
		ID: getS(m["id"]), Name: getS(m["name"]), Subreddit: getS(m["subreddit"]), Author: getS(m["author"]),
		IsSelf: getB(m["is_self"]), Domain: getS(m["domain"]),
		Title: getS(m["title"]), SelftextHTML: getS(m["selftext_html"]), Selftext: getS(m["selftext"]),
		URL: getS(m["url"]), Permalink: getS(m["permalink"]), Edited: m["edited"],
		Over18: getB(m["over_18"]), Spoiler: getB(m["spoiler"]), Locked: getB(m["locked"]), Stickied: getB(m["stickied"]),
		LinkFlairText: getS(m["link_flair_text"]), LinkFlairCSSClass: getS(m["link_flair_css_class"]),
	}
	b, err := json.Marshal(g)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func hasHashFile(dir, hash string) (bool, string, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return false, "", nil
		}
		return false, "", err
	}
	var cand []string
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if strings.HasSuffix(n, ".jsonl") && strings.Contains(n, "_"+hash) {
			cand = append(cand, n)
		}
	}
	if len(cand) == 0 {
		return false, "", nil
	}
	sort.Strings(cand)
	return true, filepath.Join(dir, cand[len(cand)-1]), nil
}

func tsFmtYYMMDDHHMMSS(unix int64) string { return time.Unix(unix, 0).UTC().Format("060102150405") }

type child struct{ Data json.RawMessage }
type page struct {
	Data struct {
		Children []child
		After    string
	}
}

func main() {
	var sub string
	var root string
	var window int
	var limit int
	var empty int
	flag.StringVar(&sub, "sub", "", "subreddit")
	flag.StringVar(&root, "root", "data/raw", "root")
	flag.IntVar(&window, "window", 30, "window days")
	flag.IntVar(&limit, "limit", 100, "limit")
	flag.IntVar(&empty, "empty", 8, "empty pages to stop")
	flag.Parse()
	if sub == "" {
		fmt.Fprintln(os.Stderr, "usage: sync -sub <name>")
		os.Exit(2)
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	ua := must("REDDIT_USER_AGENT")
	tk, err := token(must("REDDIT_CLIENT_ID"), must("REDDIT_CLIENT_SECRET"), ua)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	cutoff := time.Now().Add(-time.Duration(window) * 24 * time.Hour).Unix()
	after := ""
	emptyRun := 0
	total := 0
	for {
		u := fmt.Sprintf("https://oauth.reddit.com/r/%s/new.json?limit=%d&raw_json=1", url.PathEscape(sub), limit)
		if after != "" {
			u += "&after=" + url.QueryEscape(after)
		}
		resp, err := httpJSON("GET", u, ua, "Bearer "+tk, nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		var pg page
		if err := json.NewDecoder(resp.Body).Decode(&pg); err != nil {
			resp.Body.Close()
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		resp.Body.Close()
		if len(pg.Data.Children) == 0 {
			emptyRun++
			if emptyRun >= empty {
				break
			}
			continue
		}
		nowStr := time.Now().UTC().Format("060102150405")
		wrote := 0
		nextAfter := ""
		for _, c := range pg.Data.Children {
			var m map[string]any
			if err := json.Unmarshal(c.Data, &m); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			name, _ := m["name"].(string)
			if name != "" {
				nextAfter = name
			}
			cv := m["created_utc"]
			var created int64
			switch t := cv.(type) {
			case float64:
				created = int64(t)
			case json.Number:
				v, _ := t.Int64()
				created = v
			}
			if created < cutoff {
				emptyRun = empty
				break
			}
			id, _ := m["id"].(string)
			if id == "" || created == 0 {
				continue
			}
			dir := filepath.Join(root, "r_"+sub, "submissions", tsFmtYYMMDDHHMMSS(created)+"_"+id)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			h, err := subsetHash(c.Data)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			if ok, _, _ := hasHashFile(dir, h); ok {
				fmt.Fprintf(os.Stderr, "[%s] skip %s\n", sub, id)
				continue
			}
			out := filepath.Join(dir, nowStr+"_"+h+".jsonl")
			g, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
			if err != nil {
				if os.IsExist(err) {
					fmt.Fprintf(os.Stderr, "[%s] skip %s\n", sub, id)
					continue
				}
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			w := bufio.NewWriter(g)
			if _, err := w.Write(append(c.Data, '\n')); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			w.Flush()
			g.Close()
			wrote++
		}
		total += wrote
		fmt.Fprintf(os.Stderr, "[%s] page wrote=%d after=%q\n", sub, wrote, nextAfter)
		if nextAfter == "" {
			break
		}
		after = nextAfter
		if wrote == 0 {
			emptyRun++
		} else {
			emptyRun = 0
		}
		if emptyRun >= empty {
			break
		}
	}
	fmt.Fprintf(os.Stderr, "[%s] sync done window=%d total=%d\n", sub, window, total)
}
