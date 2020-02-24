"use strict";
const credentials = require('./credentials');
const rp = require('request-promise');
const cheerio = require('cheerio');
const Parser = require('rss-parser');
const Agent = require('socks5-http-client/lib/Agent');
const Agent_s = require('socks5-https-client/lib/Agent');
const dayjs = require('dayjs');
const fs = require('fs');
const fileType = require('file-type');
const path = require('path');
const del = require('del');
const schedule = require('node-schedule');

const log = (log) => {
    let date = dayjs(new Date())
        .format('YY年M月D日HH:mm:ss');
    console.log(`${date}: \n${log}\n`);
}

const downloadImg = (imgarr) => {
    return new Promise((resolve, reject) => {
        let promises = new Array();
        let files = new Array();
        imgarr.forEach(src => {
            let agentClass = /https/.test(src) ? Agent_s : Agent;
            let rpconfig = {
                method: 'GET',
                url: src,
                timeout: 1000 * 60,
                encoding: null
            }
            if (credentials.proxy) {
                rpconfig.agentClass = agentClass;
                rpconfig.agentOptions = {
                    socksHost: '127.0.0.1',
                    socksPort: 1080
                }
            }
            promises.push(rp(rpconfig))
        });
        Promise.all(promises)
            .then(e => {
                e.forEach(response => {
                    const imgType = fileType(response)
                        .ext;
                    const imgPath = path.relative(process.cwd(), __dirname + `/tmp/${dayjs().valueOf()}${~~(Math.random() * 10000)}.${imgType}`);
                    fs.writeFileSync(imgPath, response);
                    files.push(imgPath);
                });
                resolve(files);
            })
            .catch(err => {
                reject(err);
            })
    })
}

let upTime = new Object(); // 保存rss每次拉取的时间
const baseURL = 'https://uneasy.win/rss';

function grss(config) {
    schedule.scheduleJob('*/2 * * * *', function() {
        rp.get(baseURL + config.url, {
                timeout: 1000 * 60,
                qs: {
                    limit: 1
                }
            })
            .then(async e => {
                // 解析RSS
                const parser = new Parser();
                let feed = await parser.parseString(e);

                const date_published = dayjs(feed.items[0].pubDate)
                    .unix();
                if (!upTime[config.name]) { // 如果不存在说明是第一次请求
                    log('首次请求' + config.name);
                    upTime[config.name] = date_published;
                    return false;
                }

                if (upTime[config.name] < date_published) { //有更新
                    log('发现更新' + config.name)

                    if (feed.items[0].title.search('Re') !== -1) { // 如果是回复类型的推文则不推送
                        log('回复推文，不推送');
                        return false;
                    }

                    // 过滤图片和视频前面的换行
                    let content = feed.items[0].content.replace(/<br><video.+?><\/video>|<br><img.+?>/g, e => {
                        return e.replace(/<br>/, '');
                    })

                    // 解析HTML
                    const $ = cheerio.load(content.replace(/<br>/g, '\n'));

                    let imgArr = new Array();
                    let posterArr = new Array();

                    if ($('video')
                        .length) { // 如果有视频，尝试获取视频封面
                        let imgs = new Array();
                        $('video')
                            .each(function() {
                                let posterSrc = $(this)
                                    .attr('poster');
                                if (posterSrc) imgs.push(posterSrc);
                            })
                        try {
                            posterArr = await downloadImg(imgs);
                        } catch (error) {
                            log(config.name + '：视频封面抓取失败' + error.stack);
                            return false;
                        }
                    }

                    if ($('img')
                        .length) { // 如果有图片，请求并转换为base64编码
                        let imgs = new Array();
                        $('img')
                            .each(function() {
                                let imgSrc = $(this)
                                    .attr('src');
                                if (imgSrc) imgs.push(imgSrc);
                            })
                        try {
                            imgArr = await downloadImg(imgs);
                        } catch (error) {
                            log(config.name + '：图片抓取失败' + error.stack);
                            return false;
                        }
                    }
                    const message = {
                        text: `${config.name}更新推送`,
                        content: $('video')
                            .length ? `${$.text()}\n${$('video').length}个视频，点击原链接查看` : $.text(),
                        url: feed.items[0].link,
                        date: dayjs(feed.items[0].pubDate)
                            .format('YY年M月D日HH:mm:ss')
                    }

                    const msg =
                        `${message.text}\n` +
                        `内容：${message.content}\n` +
                        `原链接：${message.url}\n` +
                        `日期：${message.date}`


                    var options = {
                        method: 'POST',
                        uri: 'https://api.super-message.com/v1/messages?accessToken=**********************',
                        body: {
                            "toAll": true, // 可选，当 toAll 为 true，同时 recipients 为空时消息将发送给频道全体成员，其它情况按照 recipients 发送给指定成员
                            //"recipients": [string, ...],
                            /* 可选，指定接收消息的频道成员 OpenID。如果指定了接收成员，只有这部分成员会收到消
                                                               息。每次最多指定 100 个接收人 */
                            "templateID": "*****************************", // 必传，模板 ID，您在后台创建的模板
                            "templateVersion": 3, // 必传，模板版本号
                            "title": `${message.text}`, // 必传，简短的消息标题，在操作系统通知栏和频道列表页面显示，大概能让用户一眼知道消息内容最好
                            "data": {
                                "title": `${message.text}`,
                                "content": `${message.content}`,
                                "link": `${message.url}`
                            } // 可选
                        },
                        json: true // Automatically stringifies the body to JSON
                    };



                    rp(options)
                        .then(function(parsedBody) {
                            log(config.name + '更新发送成功');
                            upTime[config.name] = date_published;
                            del.sync(imgArr);
                            // POST succeeded...
                        })
                        .catch(function(err) {
                            log(config.name + ' 更新发送失败：' + error.stack);
                            del.sync(imgArr);
                            // POST failed...
                        });
                } else { //没有更新
                    log(config.name + ' 没有更新  最后更新于：' + dayjs(feed.items[0].pubDate)
                        .format('YY年M月D日HH:mm:ss'));
                }
            })
            .catch(error => {
                log(config.name + '请求RSSHub失败\n' + error.stack);
            })
    })
};

credentials.urls.forEach((config, index) => {
    setTimeout(() => {
        grss(config)
    }, 1000 * 10 * index);
})