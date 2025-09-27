package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
)

type tokenResp struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
	Scope       string `json:"scope"`
}

type listing struct {
	Data struct {
		Children []struct {
			Data json.RawMessage `json:"data"`
		} `json:"children"`
		After  any `json:"after"`
		Before any `json:"before"`
	} `json:"data"`
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fmt.Fprintf(os.Stderr, "%s not set\n", k)
		os.Exit(1)
	}
	return v
}

func getToken(clientID, clientSecret, userAgent string) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	req, err := http.NewRequest("POST", "https://www.reddit.com/api/v1/access_token", bytes.NewBufferString(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(clientID+":"+clientSecret)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("token status %d: %s", resp.StatusCode, string(b))
	}
	var tr tokenResp
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return "", err
	}
	return tr.AccessToken, nil
}

func fetchTopDay(sub, token, userAgent string, limit int) (*listing, error) {
	u := fmt.Sprintf("https://oauth.reddit.com/r/%s/top?t=day&limit=%d", url.PathEscape(sub), limit)
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("list status %d: %s", resp.StatusCode, string(b))
	}
	var lst listing
	if err := json.NewDecoder(resp.Body).Decode(&lst); err != nil {
		return nil, err
	}
	return &lst, nil
}

func main() {
	var sub string
	var out string
	var limit int
	flag.StringVar(&sub, "sub", "", "subreddit")
	flag.StringVar(&out, "out", "", "output jsonl path")
	flag.IntVar(&limit, "limit", 50, "limit")
	flag.Parse()
	if sub == "" || out == "" {
		fmt.Fprintln(os.Stderr, "usage: harvester -sub <name> -out <path> [-limit N]")
		os.Exit(2)
	}
	clientID := mustEnv("REDDIT_CLIENT_ID")
	clientSecret := mustEnv("REDDIT_CLIENT_SECRET")
	userAgent := mustEnv("REDDIT_USER_AGENT")
	token, err := getToken(clientID, clientSecret, userAgent)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	lst, err := fetchTopDay(sub, token, userAgent, limit)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	f, err := os.Create(out)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	for _, c := range lst.Data.Children {
		var m map[string]any
		if err := json.Unmarshal(c.Data, &m); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		b, err := json.Marshal(m)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if _, err := w.Write(append(b, '\n')); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	if err := w.Flush(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
