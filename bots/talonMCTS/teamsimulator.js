PossibleTeam = require("./possibleteam")
var log = require('log4js').getLogger("teamSimulator");
var TeamValidator = require("./../../ServerCode/sim/team-validator").Validator
var cloneBattleState = require("./../../cloneBattleState");

var decisionPropCalcer = require("./simpledecisionpropcalcer")

var bot = require("./../../bot");

class TeamSimulator{
    
    constructor(teamNum, battle, ownSide) {
        log.info("new Teamsimulator")
        let self = this;

        this.teamStore = [];
        let format = battle.id.slice(7, -10)
        this.teamValidator = new TeamValidator(format);
        this.history = [];
        this.ownSide = ownSide;

        this.dex = Object.keys(this.teamValidator.dex.loadData().Pokedex); //Includes all species from all Gens
        //for(let entry in dex) log.info(this.teamValidator.validateSet({species: dex[entry]}))
        this.dex = this.dex.filter(entry => { 
            let problems = self.teamValidator.validateSet({species: entry}, {});
            return (problems.length === 1); //If it is legal, only one problem must exist: "Pokemon has no moves"
        })

        //We save the first pokemon the opponent used because it has a special position. TODO: Adapt to team preview for Gen5 and following
        this.lead = battle.p2.pokemon[0].speciesid;

        for(let i = 0; i<teamNum; i++){
            if(i%(teamNum/10) === 0) log.info("Team creation " + (i*100/teamNum) + "% complete");

            /*Stupid workaround. If we calculate too long the client disconnects beacause it can't respond. 
            But if we disconnect actively and reconnect when we send something, it disconnects right before,
            we send it and not before giving us time to calculate.*/
            //bot.leave(battle.id);

            this.teamStore.push(new PossibleTeam(battle, decisionPropCalcer, this.teamValidator, this.dex, this.lead));
        }
    }

    addStateToHistory(battleState){
        this.history.push({
            state: cloneBattleState(battleState)
        });
    }

    addOwnDecisionToHistory(decision){
        let historyToken = this.history[this.history.length-1]
        historyToken.ownDecision = decision;
    }

    getHistory(){
        return this.history.map(historyToken => {
            let clonedState = cloneBattleState(historyToken.state);
            return {
                state: clonedState,
                ownDecision: historyToken.ownDecision
            };
        });
    }

    updateTeams(battle, logs){
        for(let i = 0; i<this.teamStore.length; i++){
            if(i%(this.teamStore.length/10) === 0) log.info("Updating teams " + (i*100/this.teamStore.length) + "% complete");

            /*Stupid workaround. If we calculate too long the client disconnects beacause it can't respond. 
            But if we disconnect actively and reconnect when we send something, it disconnects right before,
            we send it and not before giving us time to calculate.*/
            //bot.leave(battle.id);

            if(!this.teamStore[i].isStillPossible(battle, logs))
                this.teamStore[i] = new PossibleTeam(battle, decisionPropCalcer, this.teamValidator, this.dex, this.lead);
            this.teamStore[i].updateRank(battle, logs, this.getHistory(), this.ownSide);
        }
    }

    getRandomTeam(){
        let rankSum = this.teamStore.map(team => team.getRank()).reduce((rank1, rank2) => math.add(rank1, rank2));

        let rand = math.random(0, rankSum)
        for(let i = 0; i<this.teamStore.length; i++){
            rand = math.subtract(rand, this.teamStore[i].getRank());
            if(math.smallerEq(rand, 0))
                return this.teamStore[i];
        }
        throw new Error("mathjs doesn't work");
    }

    getPossibleTeams(){
        return this.teamStore;
    }
}

module.exports = TeamSimulator;