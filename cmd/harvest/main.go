package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

var (
	apiBase  = "https://oauth.reddit.com"
	tokenURL = "https://www.reddit.com/api/v1/access_token"
	client   = &http.Client{Timeout: 30 * time.Second}
	backoff  = 2 * time.Second
)

const expandBudget = 50

type statusErr struct {
	url   string
	code  int
	ctype string
	body  []byte
	wait  time.Duration
}

func (e *statusErr) Error() string {
	return fmt.Sprintf("%s %d %s %q", e.url, e.code, e.ctype, string(e.body))
}

func unavailable(err error) string {
	var se *statusErr
	if !errors.As(err, &se) || (se.code != http.StatusForbidden && se.code != http.StatusNotFound) {
		return ""
	}
	var r struct {
		Reason string `json:"reason"`
	}
	if json.Unmarshal(se.body, &r) != nil {
		return ""
	}
	return r.Reason
}

func must(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fmt.Fprintln(os.Stderr, k+" not set")
		os.Exit(1)
	}
	return v
}

func pause(h http.Header) time.Duration {
	for _, k := range []string{"Retry-After", "X-Ratelimit-Reset"} {
		if v, err := strconv.ParseFloat(h.Get(k), 64); err == nil && v > 0 {
			return min(time.Duration(v+1)*time.Second, 10*time.Minute)
		}
	}
	return 0
}

func once(method, u, body string, hdr map[string]string, out any) (bool, error) {
	req, err := http.NewRequest(method, u, strings.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Accept", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return true, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !strings.Contains(resp.Header.Get("Content-Type"), "application/json") {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		se := &statusErr{url: u, code: resp.StatusCode, ctype: resp.Header.Get("Content-Type"), body: b}
		if resp.StatusCode == http.StatusTooManyRequests {
			se.wait = pause(resp.Header)
		}
		return resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500, se
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return false, err
	}
	if left, err := strconv.ParseFloat(resp.Header.Get("X-Ratelimit-Remaining"), 64); err == nil && left < 5 {
		time.Sleep(pause(resp.Header))
	}
	return false, nil
}

func fetch(method, u, body string, hdr map[string]string, out any) error {
	for attempt := 0; ; attempt++ {
		retry, err := once(method, u, body, hdr, out)
		if err == nil || !retry || attempt == 3 {
			return err
		}
		wait := backoff << attempt
		var se *statusErr
		if errors.As(err, &se) && se.wait > wait {
			wait = se.wait
		}
		time.Sleep(wait)
	}
}

type session struct {
	ua    string
	token string
}

func login() (*session, error) {
	ua := must("REDDIT_USER_AGENT")
	auth := base64.StdEncoding.EncodeToString([]byte(must("REDDIT_CLIENT_ID") + ":" + must("REDDIT_CLIENT_SECRET")))
	form := url.Values{"grant_type": {"client_credentials"}, "scope": {"read"}}
	if user, pass := os.Getenv("REDDIT_USERNAME"), os.Getenv("REDDIT_PASSWORD"); user != "" && pass != "" {
		form = url.Values{"grant_type": {"password"}, "username": {user}, "password": {pass}, "scope": {"read"}}
	}
	var tr struct {
		AccessToken string `json:"access_token"`
	}
	hdr := map[string]string{"User-Agent": ua, "Authorization": "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded"}
	if err := fetch("POST", tokenURL, form.Encode(), hdr, &tr); err != nil {
		return nil, err
	}
	if tr.AccessToken == "" {
		return nil, errors.New("empty access_token")
	}
	return &session{ua: ua, token: tr.AccessToken}, nil
}

func (s *session) get(path string, q url.Values, out any) error {
	return fetch("GET", apiBase+path+"?"+q.Encode(), "", map[string]string{"User-Agent": s.ua, "Authorization": "Bearer " + s.token}, out)
}

type thing struct {
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
}

type listing struct {
	Data struct {
		Children []thing `json:"children"`
		After    string  `json:"after"`
	} `json:"data"`
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
	RemovedByCategory string `json:"removed_by_category,omitempty"`
}

func getS(v any) string {
	s, _ := v.(string)
	return s
}

func getB(v any) bool {
	b, _ := v.(bool)
	return b
}

func getF(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case json.Number:
		f, _ := t.Float64()
		return f
	}
	return 0
}

func sum(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

func postHash(m map[string]any) (string, error) {
	return sum(fp{
		ID: getS(m["id"]), Name: getS(m["name"]), Subreddit: getS(m["subreddit"]), Author: getS(m["author"]),
		IsSelf: getB(m["is_self"]), Domain: getS(m["domain"]),
		Title: getS(m["title"]), SelftextHTML: getS(m["selftext_html"]), Selftext: getS(m["selftext"]),
		URL: getS(m["url"]), Permalink: getS(m["permalink"]), Edited: m["edited"],
		Over18: getB(m["over_18"]), Spoiler: getB(m["spoiler"]), Locked: getB(m["locked"]), Stickied: getB(m["stickied"]),
		LinkFlairText: getS(m["link_flair_text"]), LinkFlairCSSClass: getS(m["link_flair_css_class"]),
		RemovedByCategory: getS(m["removed_by_category"]),
	})
}

func threadHash(rows []map[string]any) (string, error) {
	type mini struct {
		ID            string `json:"id"`
		Parent        string `json:"parent_id"`
		Author        string `json:"author"`
		Body          string `json:"body"`
		BodyHTML      string `json:"body_html"`
		Edited        any    `json:"edited"`
		Stickied      bool   `json:"stickied"`
		Distinguished any    `json:"distinguished"`
		IsSubmitter   bool   `json:"is_submitter"`
		Permalink     string `json:"permalink"`
	}
	arr := make([]mini, 0, len(rows))
	for _, r := range rows {
		arr = append(arr, mini{
			ID: getS(r["id"]), Parent: getS(r["parent_id"]), Author: getS(r["author"]),
			Body: getS(r["body"]), BodyHTML: getS(r["body_html"]), Edited: r["edited"],
			Stickied: getB(r["stickied"]), Distinguished: r["distinguished"],
			IsSubmitter: getB(r["is_submitter"]), Permalink: getS(r["permalink"]),
		})
	}
	return sum(arr)
}

func stamp(unix int64) string { return time.Unix(unix, 0).UTC().Format("060102150405") }

func newest(dir string) string {
	names, _ := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if len(names) == 0 {
		return ""
	}
	sort.Strings(names)
	base := strings.TrimSuffix(filepath.Base(names[len(names)-1]), ".jsonl")
	if i := strings.IndexByte(base, '_'); i >= 0 {
		return base[i+1:]
	}
	return ""
}

func writeCapture(dir, hash string, lines [][]byte) (bool, error) {
	if newest(dir) == hash {
		return false, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	out := filepath.Join(dir, time.Now().UTC().Format("060102150405")+"_"+hash+".jsonl")
	f, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
	if err != nil {
		if os.IsExist(err) {
			return false, nil
		}
		return false, err
	}
	w := bufio.NewWriter(f)
	for _, ln := range lines {
		w.Write(ln)
		w.WriteByte('\n')
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return false, err
	}
	return true, f.Close()
}

func savePost(root, sub string, raw json.RawMessage, cutoff int64) (bool, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return false, err
	}
	created, id := int64(getF(m["created_utc"])), getS(m["id"])
	if created == 0 || id == "" {
		return false, fmt.Errorf("post without created_utc or id: %.80s", raw)
	}
	if created < cutoff {
		return false, errOld
	}
	h, err := postHash(m)
	if err != nil {
		return false, err
	}
	return writeCapture(filepath.Join(root, "r_"+sub, "submissions", stamp(created)+"_"+id), h, [][]byte{raw})
}

var errOld = errors.New("older than the window")

func harvestPosts(s *session, root, sub string, cutoff int64, listed map[string]bool) (int, error) {
	after, wrote := "", 0
	for {
		q := url.Values{"limit": {"100"}, "raw_json": {"1"}}
		if after != "" {
			q.Set("after", after)
		}
		var l listing
		if err := s.get("/r/"+url.PathEscape(sub)+"/new.json", q, &l); err != nil {
			return wrote, err
		}
		for _, c := range l.Data.Children {
			var meta struct {
				ID string `json:"id"`
			}
			json.Unmarshal(c.Data, &meta)
			listed[meta.ID] = true
			ok, err := savePost(root, sub, c.Data, cutoff)
			if errors.Is(err, errOld) {
				return wrote, nil
			}
			if err != nil {
				return wrote, err
			}
			if ok {
				wrote++
			}
		}
		if len(l.Data.Children) == 0 || l.Data.After == "" {
			return wrote, nil
		}
		after = l.Data.After
	}
}

type tree struct {
	rows map[string]map[string]any
	more []string
	cont []string
	seen map[string]bool
}

func (t *tree) addThing(kind string, d map[string]any) {
	switch kind {
	case "t1":
		if rep, ok := d["replies"].(map[string]any); ok {
			if rd, ok := rep["data"].(map[string]any); ok {
				t.addChildren(rd["children"])
			}
		}
		delete(d, "replies")
		if id := getS(d["id"]); id != "" {
			t.rows[id] = d
		}
	case "more":
		ids, _ := d["children"].([]any)
		if len(ids) == 0 {
			parent := getS(d["parent_id"])
			if pid := strings.TrimPrefix(parent, "t1_"); pid != parent && !t.seen["c"+pid] {
				t.seen["c"+pid] = true
				t.cont = append(t.cont, pid)
			}
			return
		}
		for _, v := range ids {
			if id := getS(v); id != "" && !t.seen["m"+id] {
				t.seen["m"+id] = true
				t.more = append(t.more, id)
			}
		}
	}
}

func (t *tree) addChildren(v any) {
	arr, _ := v.([]any)
	for _, c := range arr {
		obj, _ := c.(map[string]any)
		if d, ok := obj["data"].(map[string]any); ok {
			t.addThing(getS(obj["kind"]), d)
		}
	}
}

func (t *tree) addListing(raw json.RawMessage) error {
	var l struct {
		Data struct {
			Children []any `json:"children"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &l); err != nil {
		return err
	}
	t.addChildren(l.Data.Children)
	return nil
}

func (t *tree) expand(s *session, id string) (int, error) {
	for budget := expandBudget; budget > 0 && len(t.more)+len(t.cont) > 0; budget-- {
		if len(t.cont) > 0 {
			pid := t.cont[0]
			t.cont = t.cont[1:]
			var arr []json.RawMessage
			q := url.Values{"comment": {pid}, "depth": {"1000"}, "limit": {"500"}, "raw_json": {"1"}, "sort": {"confidence"}}
			if err := s.get("/comments/"+url.PathEscape(id)+".json", q, &arr); err != nil {
				return 0, err
			}
			if len(arr) > 1 {
				if err := t.addListing(arr[1]); err != nil {
					return 0, err
				}
			}
			continue
		}
		var ids []string
		for len(t.more) > 0 && len(ids) < 100 {
			if _, ok := t.rows[t.more[0]]; !ok {
				ids = append(ids, t.more[0])
			}
			t.more = t.more[1:]
		}
		if len(ids) == 0 {
			continue
		}
		var resp struct {
			JSON struct {
				Data struct {
					Things []any `json:"things"`
				} `json:"data"`
			} `json:"json"`
		}
		q := url.Values{"api_type": {"json"}, "link_id": {"t3_" + id}, "children": {strings.Join(ids, ",")}, "limit_children": {"false"}, "raw_json": {"1"}}
		if err := s.get("/api/morechildren", q, &resp); err != nil {
			return 0, err
		}
		t.addChildren(resp.JSON.Data.Things)
	}
	return len(t.more) + len(t.cont), nil
}

func fetchThread(s *session, id string) (json.RawMessage, []map[string]any, int, error) {
	var arr []json.RawMessage
	q := url.Values{"depth": {"1000"}, "limit": {"500"}, "raw_json": {"1"}, "sort": {"confidence"}}
	if err := s.get("/comments/"+url.PathEscape(id)+".json", q, &arr); err != nil {
		return nil, nil, 0, err
	}
	if len(arr) < 2 {
		return nil, nil, 0, errors.New("unexpected comments payload")
	}
	var post listing
	if err := json.Unmarshal(arr[0], &post); err != nil {
		return nil, nil, 0, err
	}
	var raw json.RawMessage
	if len(post.Data.Children) > 0 && post.Data.Children[0].Kind == "t3" {
		raw = post.Data.Children[0].Data
	}
	t := &tree{rows: map[string]map[string]any{}, seen: map[string]bool{}}
	if err := t.addListing(arr[1]); err != nil {
		return nil, nil, 0, err
	}
	left, err := t.expand(s, id)
	if err != nil {
		return nil, nil, 0, err
	}
	rows := make([]map[string]any, 0, len(t.rows))
	for _, r := range t.rows {
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool {
		pi, pj := getS(rows[i]["parent_id"]), getS(rows[j]["parent_id"])
		if pi != pj {
			return pi < pj
		}
		ci, cj := getF(rows[i]["created_utc"]), getF(rows[j]["created_utc"])
		if ci != cj {
			return ci < cj
		}
		return getS(rows[i]["id"]) < getS(rows[j]["id"])
	})
	return raw, rows, left, nil
}

func harvestComments(s *session, root, sub string, cutoff int64, listed map[string]bool) (int, error) {
	dirs, _ := filepath.Glob(filepath.Join(root, "r_"+sub, "submissions", "*_*"))
	sort.Strings(dirs)
	wrote, failed, scanned := 0, 0, 0
	for _, d := range dirs {
		createdID := filepath.Base(d)
		if createdID < stamp(cutoff) {
			continue
		}
		scanned++
		_, id, _ := strings.Cut(createdID, "_")
		post, rows, left, err := fetchThread(s, id)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[%s] %s fetch_error: %v\n", sub, id, err)
			failed++
			continue
		}
		if left > 0 {
			fmt.Fprintf(os.Stderr, "[%s] %s truncated, %d stubs left\n", sub, id, left)
		}
		if post != nil && !listed[id] {
			if _, err := savePost(root, sub, post, 0); err != nil {
				return wrote, err
			}
		}
		if len(rows) == 0 {
			continue
		}
		h, err := threadHash(rows)
		if err != nil {
			return wrote, err
		}
		lines := make([][]byte, 0, len(rows))
		for _, r := range rows {
			b, err := json.Marshal(r)
			if err != nil {
				return wrote, err
			}
			lines = append(lines, b)
		}
		ok, err := writeCapture(filepath.Join(root, "r_"+sub, "comments", createdID), h, lines)
		if err != nil {
			return wrote, err
		}
		if ok {
			wrote++
		}
	}
	fmt.Fprintf(os.Stderr, "[%s] comments scanned=%d wrote=%d failed=%d\n", sub, scanned, wrote, failed)
	if failed > 0 {
		return wrote, fmt.Errorf("%d of %d threads failed", failed, scanned)
	}
	return wrote, nil
}

func readSubs(path string) ([]string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var subs []string
	for _, ln := range strings.Split(string(b), "\n") {
		ln = strings.TrimSpace(ln)
		if ln != "" && !strings.HasPrefix(ln, "#") {
			subs = append(subs, ln)
		}
	}
	if len(subs) == 0 {
		return nil, fmt.Errorf("no subreddits in %s", path)
	}
	return subs, nil
}

func main() {
	var root, subsFile string
	var days int
	flag.StringVar(&root, "root", "data/raw", "data root")
	flag.StringVar(&subsFile, "subs", "configs/subreddits.txt", "subreddit list")
	flag.IntVar(&days, "days", 16, "days to look back")
	flag.Parse()
	subs, err := readSubs(subsFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	s, err := login()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour).Unix()
	failed := 0
	for i, sub := range subs {
		fmt.Fprintf(os.Stderr, "[harvest] (%d/%d) sub=%s days=%d\n", i+1, len(subs), sub, days)
		listed := map[string]bool{}
		n, err := harvestPosts(s, root, sub, cutoff, listed)
		if r := unavailable(err); r != "" {
			fmt.Fprintf(os.Stderr, "[%s] unavailable reason=%s\n", sub, r)
			continue
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "[%s] posts failed: %v\n", sub, err)
			failed++
			continue
		}
		fmt.Fprintf(os.Stderr, "[%s] posts wrote=%d\n", sub, n)
		if _, err := harvestComments(s, root, sub, cutoff, listed); err != nil {
			fmt.Fprintf(os.Stderr, "[%s] comments failed: %v\n", sub, err)
			failed++
		}
	}
	if failed > 0 {
		fmt.Fprintf(os.Stderr, "[harvest] %d of %d subs failed\n", failed, len(subs))
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "[harvest] all done subs=%d\n", len(subs))
}
