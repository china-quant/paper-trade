import moment from 'moment-timezone'
import EveryDay from '../everyDay'
import request from 'request-promise'
import Config from '../../config'
import { dwUrls } from '../driveWealth'
import sqlstr from '../sqlStr'
import singleton from '../singleton'
const { mainDB, redisClient } = singleton

export default new EveryDay("04:30:00", async() => {
    let weekDay = moment().day();
    let LastDate = moment().day(weekDay < 2 ? -5 : 2).format('YYYY-MM-DD');
    let round = 0
    let e401 = 0
    async function createAsset({ UserId, MemberCode, username, password, emailAddress1 }) {
        try {
            let { sessionKey, accounts } = await request({
                uri: dwUrls.createSession,
                method: "POST",
                body: {
                    "appTypeID": "2000",
                    "appVersion": "0.1",
                    username,
                    "emailAddress": emailAddress1,
                    "ipAddress": "1.1.1.1",
                    "languageID": "zh_CN",
                    "osVersion": "iOS 9.1",
                    "osType": "iOS",
                    "scrRes": "1920x1080",
                    password
                },
                timeout: 10000,
                json: true
            })
            let [{ userID, cash, accountNo, accountID }] = accounts
            let { positions } = await request({
                headers: { 'x-mysolomeo-session-key': sessionKey },
                qs: {
                    sessionKey,
                    ReportName: "PositionRestingOrder",
                    ReportFormat: "JSON",
                    AccountNumber: accountNo
                },
                timeout: 10000,
                uri: dwUrls.position,
                method: "POST",
                json: true
            })
            if (positions) {
                let Positions = positions.reduce((acc, val) => acc + val.mtm, 0) //总的持仓资产
                let MtmPL = positions.reduce((acc, val) => acc + val.mtmPL, 0) //总的持仓浮动盈亏
                let replacements = [Config.practiceInitFun, LastDate, UserId, MemberCode, accountID, cash, Positions, cash + Positions, MtmPL]
                await mainDB.query("CALL PRC_WF_ASSET(?,?,?,?,?,?,?,?,?)", { replacements })
            } else {
                let replacements = [Config.practiceInitFun, LastDate, UserId, MemberCode, accountID, cash, 0, cash, 0]
                await mainDB.query("CALL PRC_WF_ASSET(?,?,?,?,?,?,?,?,?)", { replacements })
            }
            let { transaction } = await request({
                headers: { 'x-mysolomeo-session-key': sessionKey },
                uri: "https://reports.drivewealth.net/DriveWealth",
                method: "POST",
                qs: {
                    sessionKey,
                    "ReportName": "OrderTrans",
                    "ReportFormat": "JSON",
                    "AccountNumber": accountNo,
                    "wlpID": "DW",
                    "LanguageID": "zh_CN",
                    "DateStart": moment(moment().add(-1, 'days').format('YYYY-MM-DD 08:00:00')).toISOString(), //昨天0点
                    "DateEnd": moment(moment().format('YYYY-MM-DD 08:00:00')).toISOString() //今天0点
                },
                timeout: 10000,
                json: true
            })
            console.log(transaction)

            if (transaction && transaction.length) {
                for (let ttmp of transaction) {
                    mainDB.query("insert into wf_drivewealth_practice_order(MemberCode,AccountType,OrdStatus,OrdNo,AccountNo,SecuritiesType,SecuritiesNo,Price,OrderQty,Side,OrdType,ExecType,CreateTime) values(:MemberCode,:AccountType,:OrdStatus,:OrdNo,:AccountNo,'us',:SecuritiesNo,:Price,:OrderQty,:Side,:OrdType,:ExecType,:CreateTime)", {
                        replacements: { MemberCode, AccountType: 1, OrdStatus: ttmp.ordStatus, OrdNo: ttmp.orderNo, AccountNo: accountNo, SecuritiesNo: ttmp.symbol, Price: ttmp.lastPx, OrderQty: ttmp.cumQty, Side: ttmp.side, OrdType: ttmp.ordType, ExecType: ttmp.execType, CreateTime: ttmp.transactTime }
                    })
                }
            }

            let { equity: { equityPositions } } = await request({
                headers: { 'x-mysolomeo-session-key': sessionKey },
                method: "GET",
                //encoding: null,
                uri: "http://api.drivewealth.net/v1/users/" + userID + "/accountSummary/" + accountID,
                json: true,
                timeout: 5000
            })


            if (equityPositions.length) {
                await singleton.deleteMainDB("wf_drivewealth_practice_position", { MemberCode })
                for (let tmp of equityPositions) {
                    singleton.insertMainDB("wf_drivewealth_practice_position", { userID, accountID, MemberCode, ...tmp }, { CreateTime: "now()" })
                }
            }

        } catch (ex) {
            if (ex.statusCode == 401) {
                e401++
            } else {
                console.error(new Date(), ex)
            }
        }
    }
    while (round < 10) {
        let [result] = await mainDB.query('select wf_drivewealth_practice_account.* from wf_drivewealth_practice_account where `MemberCode`  not in (SELECT `MemberCode` from `wf_drivewealth_practice_asset` WHERE EndDate = CurDate())')
        if (!result.length)
            break
        await Promise.all(result.map(data => createAsset(data)))
        round++
        console.log("第" + round + "轮：" + e401)
        e401 = 0
    }

    //活动期间将真数据插入wf_drivewealth_practice_asset_v
    //await mainDB.query("insert into wf_drivewealth_practice_asset_v(UserId,AccountID,Balance,MtmPL,Positions,TodayProfit,TodayYield,WeekProfit,WeekYield,MonthProfit,MonthYield,YearProfit,YearYield,TotalProfit,TotalYield,TotalAmount,MemberCode,EndDate,CreateTime) select UserId,AccountID,Balance,MtmPL,Positions,TodayProfit,TodayYield,WeekProfit,WeekYield,MonthProfit,MonthYield,YearProfit,YearYield,TotalProfit,TotalYield,TotalAmount,MemberCode,EndDate,CreateTime from wf_drivewealth_practice_asset where EndDate=CurDate() and MemberCode in(select MemberCode from wf_stockcompetitionmember where CompetitionId = 1 and Source<>1)");
    /*
        let [fakemembercoderesult] = await mainDB.query("select a.MemberCode,b.UserId  from wf_stockcompetitionmember a left join wf_drivewealth_practice_account b on a.MemberCode=b.MemberCode  where Source=1");
        if (fakemembercoderesult.length) {
            for (let { MemberCode, UserId }
                of fakemembercoderesult) {
                let replacements = { UserId, MemberCode }
                let [fakeresult] = await mainDB.query('select TotalAmount from wf_drivewealth_practice_asset_v where UserId=:UserId and EndDate<CurDate() order by EndDate desc limit 1', { replacements })
                let [fakeweekresult] = await mainDB.query("select TotalAmount from wf_drivewealth_practice_asset_v where UserId=:UserId and EndDate<:LastDate order by EndDate desc limit 1 ", { replacements: { LastDate, UserId } });
                // if (moment().day() == 0 || moment().day() == 1 || moment().format('YYYY-MM-DD') == "2017-05-29") {
                //     replacements.TotalAmount = fakeresult.length ? fakeresult[0].TotalAmount : Config.practiceInitFun
                // } else {
                //     let rand = 1 + Math.random() * Config.randmax / 100
                //     rand = rand.toFixed(4)
                //     replacements.TotalAmount = fakeresult.length ? fakeresult[0].TotalAmount * rand : Config.practiceInitFun * rand
                // }

                replacements.TotalAmount = fakeresult.length ? fakeresult[0].TotalAmount : Config.practiceInitFun
                replacements.TodayProfit = replacements.TotalAmount - (fakeresult.length ? fakeresult[0].TotalAmount : Config.practiceInitFun)
                replacements.WeekProfit = replacements.TotalAmount - (fakeweekresult.length ? fakeweekresult[0].TotalAmount : Config.practiceInitFun)
                replacements.WeekYield = replacements.WeekProfit / (fakeweekresult.length ? fakeweekresult[0].TotalAmount : Config.practiceInitFun) * 100
                replacements.TotalProfit = replacements.TotalAmount - Config.practiceInitFun
                replacements.TotalYield = replacements.TotalProfit / Config.practiceInitFun * 100
                replacements.MtmPL = replacements.TotalProfit //总的持仓浮动盈亏
                await mainDB.query(sqlstr.insert("wf_drivewealth_practice_asset_v", replacements, { CreateTime: "now()", EndDate: "curDate()" }), { replacements })
                await mainDB.query(sqlstr.insert("wf_drivewealth_practice_asset", replacements, { CreateTime: "now()", EndDate: "curDate()" }), { replacements })
            }
        }
    */

    //缓存总资产排行
    let [totalAmountResult] = await mainDB.query("select dw.MemberCode,round(dw.TotalAmount) TotalAmount,wf_member.Nickname,concat(:picBaseURL,wf_member.HeadImage) HeadImage from wf_drivewealth_practice_asset as dw left join wf_member on dw.MemberCode=wf_member.MemberCode where dw.EndDate=CurDate() order by dw.TotalAmount desc limit 100", { replacements: { picBaseURL: Config.picBaseURL } })
    redisClient.set("RankList:totalAssets", JSON.stringify(totalAmountResult));
    //缓存日收益排行
    let [todayProfitResult] = await mainDB.query("select dw.MemberCode,round(dw.TodayProfit) TodayProfit,wf_member.Nickname,concat(:picBaseURL,wf_member.HeadImage) HeadImage from wf_drivewealth_practice_asset as dw left join wf_member on dw.MemberCode=wf_member.MemberCode  where dw.EndDate=CurDate() order by dw.TodayProfit desc limit 100", { replacements: { picBaseURL: Config.picBaseURL } })
    redisClient.set("RankList:todayProfit", JSON.stringify(todayProfitResult));

    mainDB.query('CALL PRC_WF_PRACTICE_RANK();')
        //if (moment().day() == 0 || moment().day() == 1)
    await mainDB.query('CALL PRC_WF_PRACTICE_RANK_V();')

    if (weekDay == 6) {
        let now = moment([moment().format('YYYY'), moment().format('MM'), moment().format('DD')]);
        let before = moment([2017, 07, 08]);
        singleton.callMainDB("PRC_WF_COMPETITION_REPORT", Math.floor(now.diff(before, 'days') / 7));
        //singleton.callMainDB("PRC_WF_COMEPTITION_REPORT", moment().weeksInYear() - moment("20170708", "YYYMMDD").weeksInYear() + 1)
    }
    //缓存炒股大赛总排行
    let [matchTotalProfitReulst] = await mainDB.query("SELECT c.*,wf_member.NickName,concat(:picBaseURL,case when isnull(wf_member.HeadImage) or wf_member.HeadImage='' then :defaultHeadImage else wf_member.HeadImage end)HeadImage FROM (SELECT a.RankValue totalamount,b.RankValue totalprofit,a.MemberCode,a.Rank from wf_drivewealth_practice_rank_v a ,wf_drivewealth_practice_rank_v b where a.MemberCode = b.MemberCode and a.Type = 11 and b.Type = 10 limit 100)c left join wf_member on wf_member.MemberCode=c.MemberCode ORDER BY c.rank ", { replacements: { picBaseURL: Config.picBaseURL, defaultHeadImage: Config.defaultHeadImage } })
    redisClient.set("RankList:matchTotalProfit", JSON.stringify(matchTotalProfitReulst));
    //缓存炒股大赛周排行
    let [matchWeekProfitReulst] = await mainDB.query("SELECT c.*,wf_member.NickName,concat(:picBaseURL,case when isnull(wf_member.HeadImage) or wf_member.HeadImage='' then :defaultHeadImage else wf_member.HeadImage end)HeadImage FROM (SELECT a.RankValue totalamount,b.RankValue totalprofit,a.MemberCode,a.Rank from wf_drivewealth_practice_rank_v a ,wf_drivewealth_practice_rank_v b where a.MemberCode = b.MemberCode and a.Type = 3 and b.Type = 4 limit 100)c left join wf_member on wf_member.MemberCode=c.MemberCode ORDER BY c.rank ", { replacements: { picBaseURL: Config.picBaseURL, defaultHeadImage: Config.defaultHeadImage } })
    redisClient.set("RankList:matchWeekProfit", JSON.stringify(matchWeekProfitReulst))
})
