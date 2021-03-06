var math = require("mathjs")
var log = require('log4js').getLogger("teamSimulator");

var nnClient = require("./nnClient");
var BattlePokemon = require("./../../servercode/sim/pokemon");
var TeamValidator = require("./../../servercode/sim/team-validator");
var cloneBattleState = require("../../clone/cloneBattleState")

class PossibleTeam {
	constructor(battle, teamValidator, lead) {
        this.rank = 1;
		/** @type {TeamValidator} */
        this.teamValidator = teamValidator;
        this.requestsConsideredForRank = 0;

        this.team = [];
        this.confirmedTeam = [];
        this.battleFormat = battle.format;
        this.nnClient = nnClient.getClient(this.battleFormat);

        this.init(battle, lead);
    }

    init(battle, lead){
        let leadIndex = battle.p2.pokemon.findIndex(poke => poke.speciesid === lead);

        for(let i = 0; i < battle.p2.maxTeamSize; i++){
            this.team.push({});
            this.confirmedTeam.push({moves:[]})

            let registeredPokemon;
            //Put the lead at the first position.
            if(i==0)
                registeredPokemon = battle.p2.pokemon[leadIndex];
            else if(i<=leadIndex){
                registeredPokemon = battle.p2.pokemon[i-1];
            } else if(i>leadIndex){
                registeredPokemon = battle.p2.pokemon[i];
            }

            if(registeredPokemon){
                this.team[i].species = registeredPokemon.speciesid;
                this.team[i].name = registeredPokemon.name;
                this.team[i].level = registeredPokemon.level;
            } else {
                this.team[i].name = this.team[i].species = this.nnClient.getSpeciesChoice(this.team)
                this.team[i].level = this.nnClient.getLevelChoice(this.team)
            }

            this.team[i].moves = [];
            for(let j = 0; j < 4; j++){
                let legalMoveOptions = this.getLegalMoveOptions(i);
                if(!legalMoveOptions.length) break;

                let move;
                if(registeredPokemon && registeredPokemon.baseMoveSlots[j]){
                    move = registeredPokemon.baseMoveSlots[j].id;
                } else {
                    move = this.nnClient.getMoveChoice(this.team, legalMoveOptions).move;
                }

                this.team[i].moves.push(move);
            }
        }
    
        this.updateTeamBuildingRank(battle.p2.pokemon);
    }

    getLegalMoveOptions(teamIndex, moveIndex = -1){
        let self = this;
        let legalMoveOptions = [];
        let pokemon = this.team[teamIndex];
        if(moveIndex === -1) moveIndex = pokemon.moves.length;
        let otherMoves = pokemon.moves.slice(0, moveIndex)

        //Add learnable moves of preevolutions
        let template = this.teamValidator.dex.getTemplate(pokemon.species);
        for(; template.learnset; template = this.teamValidator.dex.getTemplate(template.prevo))
            legalMoveOptions.push(...Object.keys(template.learnset).filter(m => !legalMoveOptions.includes(m)));
        
        //Filter illegal options
        legalMoveOptions = legalMoveOptions.filter(move => { 
            let problems = self.teamValidator.validateSet({species: pokemon.species, moves: otherMoves.concat(move)}, {});
            return (!problems);
        });

        //Remove duplicates;
        legalMoveOptions = legalMoveOptions.filter(move => !otherMoves.includes(move));

        return legalMoveOptions;
    }

    updateRank(battle, battleLogs, history, ownSide){
        let self = this;

        this.updateTeamBuildingRank(battle.p2.pokemon);

        let pastTurns = battleLogs.split("\n\n");
        pastTurns = pastTurns.filter(request => request.includes("|switch|") || request.includes("|move|") || request.includes("|cant|"));
        pastTurns = pastTurns.slice(this.requestsConsideredForRank);

        pastTurns.forEach((turnLog, index) => {
            let historyIndex = index + self.requestsConsideredForRank - 1;
            if(historyIndex === -1) return;
            let historyToken = {
                ownDecision: history[historyIndex].ownDecision,
                state: cloneBattleState(history[historyIndex].state)
            };

            this.updateRankForTurn(turnLog, historyToken, ownSide);
            historyToken.state.destroy();
        });

        this.requestsConsideredForRank += pastTurns.length;

    }

    updateRankForTurn(turnLog, historyToken, ownSide){
        let request = this.getOppReqest(historyToken.state);
        if(request.wait) return;

        //Rank times probability for opponent chosing the option the opponent chose
        let options = this.nnClient.getRequestOptions(historyToken.state, "p2", request);
        let chosenOption = this.getChosenOption(historyToken, turnLog, options, ownSide);
        
        if(chosenOption.length === 0){
            debugger;
            this.getOppReqest(historyToken.state);
            this.getChosenOption(historyToken, turnLog, options, ownSide, true);
            throw new Error("Chosen option for a turn can't be specified. Turnlog: " + turnLog + "\nOptions: " + options.map(option => option.decision.type + " " + option.decision.id) + "\nOpponent's request: " + JSON.stringify(request));
        }

        let probabilitySum = options.map(option => option.probability).reduce((prob1, prob2) =>  math.add(prob1, prob2));
        let probability = chosenOption.map(option => option.probability).reduce((prob1, prob2) =>  math.add(prob1, prob2));
        this.rank = math.multiply(this.rank, math.divide(probability, probabilitySum));
    }

    getOppReqest(battleState){
        if(!battleState) return battleState;

        this.completeBattle(battleState);

        let activePokemonP1 = battleState.p1.active[0];
        let activePokemonP2 = battleState.p2.active[0];
        let currentRequest = activePokemonP2.switchFlag || activePokemonP1.switchFlag ? "switch" : "move";

        battleState.makeRequest(currentRequest);
        return battleState.p2.request;
    }

    completeBattle(battle){
        let self = this;
        for(const simPoke of this.team){
            let p = battle.p2.pokemon.findIndex(poke => poke.speciesid === simPoke.species);
            if(p === -1) p = battle.p2.pokemon.push(null) - 1;

            var template = {
                name: simPoke.name,
                species: simPoke.species,
                level: simPoke.level,
                moves: simPoke.moves.map(move => self.teamValidator.dex.getMove(move))
            };

            if(battle.gen < 3){
                template.evs = {
                    hp: 252,
                    atk: 252,
                    def: 252,
                    spa: 252,
                    spd: 252,
                    spe: 252
                }
            }

            let pokemon = new BattlePokemon(template, battle.p2);

            if(!battle.p2.pokemon[p]){
                battle.p2.pokemon[p] = pokemon;
                battle.p2.pokemon[p].position = p;
                continue;
            }

            battle.p2.pokemon[p].baseMoveSlots = pokemon.baseMoveSlots;
            battle.p2.pokemon[p].hpType = pokemon.hpType;
            battle.p2.pokemon[p].baseIvs = pokemon.baseIvs;
            battle.p2.pokemon[p].hp = parseFloat(battle.p2.pokemon[p].hp)/battle.p2.pokemon[p].maxhp*pokemon.maxhp;
            battle.p2.pokemon[p].maxhp = pokemon.maxhp;
            battle.p2.pokemon[p].happiness = pokemon.happiness;
            battle.p2.pokemon[p].level = pokemon.level;
            battle.p2.pokemon[p].stats = pokemon.stats;
        }

        for(let poke of battle.p2.pokemon){
            if(poke.transformed) continue;

            let moveSlotsBackup = poke.moveSlots
            poke.moveSlots = [];
            poke.baseMoveSlots.forEach(baseMoveSlot => {
                //When mimic is used, its moveSlot is replaced with a virtual move.
                if(baseMoveSlot.id === "mimic" && moveSlotsBackup.some(moveSlot => moveSlot.virtual)) {
                    poke.moveSlots.push(moveSlotsBackup.find(moveSlot => moveSlot.virtual));
                    return;
                } 

                //if(!activePokemonP2.moveSlots.some(moveSlot => moveSlot.id === baseMoveSlot.id))
                poke.moveSlots.push(baseMoveSlot);
            });
        }

        if(battle.p2.pokemon.length > 6) {
            debugger;
            let stillPossible = this.isStillPossible(battle);
        }
        try{
            battle.makeRequest();
        } catch(e){
            debugger;
            battle.makeRequest();
            throw e;
        } 
 
    }

    getChosenOption(historyToken, turnLog, options, ownSide, doLog = false){
        let self = this;
        let oppSide = ownSide === "p1" ? "p2" : "p1";
        
        //Step 1: Get action order
        let getActedIndex = function(playerId){
            let index = turnLog.indexOf("|switch|" + playerId + "a:");
            if(index > 0) return index;

            index = turnLog.indexOf("|move|" + playerId + "a:");
            if(index > 0) return index;

            index = turnLog.indexOf("|cant|" + playerId + "a:");
            if(index > 0) return index;

            index = turnLog.indexOf("|-curestatus|" + playerId + "a:");
            if(index > 0) return index;

            return turnLog.length;
        };

        let oppActedIndex = getActedIndex(oppSide);
        let weActedIndex = getActedIndex(ownSide);
        let weActedFirst = weActedIndex < oppActedIndex;

        //Step 2: get confirmed speed and priority of our own choice
        let ownPriority = !historyToken.ownDecision ? -1000 : 
            historyToken.ownDecision.type === "switch" ? 7 : 
            this.teamValidator.dex.getMove(historyToken.ownDecision.id).priority;
        let ownPokemon = historyToken.state.p1.pokemon.find(pokemon => pokemon.isActive);
        let ownSpeed = ownPokemon ? ownPokemon.getActionSpeed() : 10000;
        let oppPokemon = historyToken.state.p2.pokemon.find(pokemon => pokemon.isActive);
        let oppSpeed = oppPokemon ? oppPokemon.getActionSpeed() : 10000;
        //if(doLog) log.info("Turnlog: " + turnLog + "\nWe acted first? " + weActedFirst + "Own speed: " + ownSpeed + " opponent's speed: " + oppSpeed);
        //log.info("We acted first? " + weActedFirst + "\n Turnlog: " + turnLog + "\nOwn speed: " + ownSpeed + "\n Opp speed: " + oppSpeed)

        //Step 3: Filter out all options with an priority that would result in a different action order 
        let canOptionBeChosenBasedOnPriority = function(option){
            let oppPriority = option.decision.type === "switch" ? 7 : 
                self.teamValidator.dex.getMove(option.decision.id).priority;
            if(weActedFirst){
                if(oppPriority < ownPriority || (oppPriority === ownPriority && oppSpeed < ownSpeed))
                    return true;
                if(oppPriority === ownPriority && oppSpeed === ownSpeed){
                    option.probability = math.divide(option.probability, 2);//Chance of us winning the speed tie
                    return true;
                }
            } else {
                if(oppPriority > ownPriority || (oppPriority === ownPriority && oppSpeed > ownSpeed))
                    return true;
                if(oppPriority === ownPriority && oppSpeed === ownSpeed){
                    option.probability = math.divide(option.probability, 2);//Chance of opponent winning the speed tie
                    return true;
                }
            }
            return false;
        }
        options = options.filter(canOptionBeChosenBasedOnPriority);
        //if(doLog) log.info("Remaining options after filtering wrong order: " + options.map(option => option.decision));

        //if(!options.length) throw new Error("Move order wrong. \nWe acted first? " + weActedFirst + "\n Turnlog: " + turnLog + "\nOwn speed: " + ownSpeed + "\n Opp speed: " + oppSpeed);

        //Step 4: If the opponent switched to a different Pokemon and we know it, return only that one option that is confirmed
        let oppSwitchPrefix = "|switch|" + oppSide + "a:"
        let opponentSwitchedIndex = turnLog.indexOf(oppSwitchPrefix);

        if(opponentSwitchedIndex !== -1){
            options = options.filter(option => option.decision.type === "switch");
            let switchIn = turnLog.slice(opponentSwitchedIndex).split("|")[2].slice(5);
            let switchInId = historyToken.state.p2.pokemon.find(pokemon => pokemon.name === switchIn).position;

            options = options.filter(option => option.decision.id.toString() === switchInId.toString());
            return options;
        }

        //Step 5: If opponent was able to move, return the move choice.
        options = options.filter(option => option.decision.type !== "switch")
        let oppMovePrefix = "|move|" + oppSide + "a:";
        let opponentMovedIndex = turnLog.indexOf(oppMovePrefix);

        if(opponentMovedIndex != -1){
            let chosenMove = turnLog.slice(opponentMovedIndex).split("|")[3];
            chosenMove = this.teamValidator.dex.getMove(chosenMove).id;
            options = options.filter(option => option.decision.id.toString() === chosenMove.toString());
            return options;
        }
        
        return options;
    }

    updateTeamBuildingRank(opponentTeam){
        //Find out whether we got new team information and if there is, multiply the rank by its decision probability
        for(let oppTeamIndex in opponentTeam){
            let oppPokemon = opponentTeam[oppTeamIndex];
            let confirmedTeamIndex = this.confirmedTeam.findIndex(pokemon => pokemon.name && pokemon.name === oppPokemon.name);
            let confirmedPokemon = this.confirmedTeam[confirmedTeamIndex];

            //If newly discovered opposing Pokemon
            if(confirmedTeamIndex === -1){
                confirmedPokemon = this.updateRankForSpeciesAndLevel(oppPokemon)
            }
            
            for(let baseMoveSlotsIndex in opponentTeam[oppTeamIndex].baseMoveSlots){
                let confirmedMove = opponentTeam[oppTeamIndex].baseMoveSlots[baseMoveSlotsIndex].id;
                let confirmedMoveIndex = confirmedPokemon.moves.findIndex(move => move.toLowerCase() === confirmedMove.toLowerCase());
                
                //If new information
                if(confirmedMoveIndex == -1){
                    //Mark as confirmed
                    confirmedMoveIndex = confirmedPokemon.moves.length;
                    confirmedPokemon.moves.push(confirmedMove);

                    //Replicate unfinished team state during that move decision
                    let teamIndex = this.team.findIndex(pokemon => pokemon.species.toLowerCase() === confirmedPokemon.species.toLowerCase());
                    let unfinishedTeam = [];
                    for(let i = 0; i < teamIndex; i++){
                        unfinishedTeam.push({species: this.team[i].species, moves: this.team[i].moves});
                    }
                    let teamMoveIndex = this.team[teamIndex].moves.findIndex(move => move === opponentTeam[oppTeamIndex].baseMoveSlots[baseMoveSlotsIndex].id);
                    unfinishedTeam.push({species: this.team[teamIndex].species, moves: this.team[teamIndex].moves.slice(0, teamMoveIndex)});

                    let legalMoveOptions = this.getLegalMoveOptions(teamIndex, teamMoveIndex);

                    let options = this.nnClient.getMoveChoiceOptions(unfinishedTeam, legalMoveOptions);
                    let decision = options.find(option => option.move.toLowerCase() === confirmedMove.toLowerCase());

                    this.rank = math.multiply(this.rank, decision.probability);
                }
            }
        }

    }

    updateRankForSpeciesAndLevel(oppPokemon){
        let self = this;
        //Mark as confirmed
        let confirmedTeamIndex = this.confirmedTeam.findIndex(pokemon => !pokemon.name);
        if(confirmedTeamIndex === -1) {
            debugger;
            throw new Error("Found new confirmed pokemon " + oppPokemon.speciesid + " despite maximal team size already reached: " + this.confirmedTeam.length);
        }
        let confirmedPokemon = this.confirmedTeam[confirmedTeamIndex];
        confirmedPokemon.species = oppPokemon.speciesid;

        //Replicate unfinished team state during that decision
        let teamIndex = this.team.findIndex(pokemon => pokemon.species === oppPokemon.speciesid);
        let unfinishedTeam = [];
        for(let i = 0; i < teamIndex; i++){
            unfinishedTeam.push({species: this.team[i].species, moves: this.team[i].moves})
        }

        //save name
        this.team[teamIndex].name = confirmedPokemon.name = oppPokemon.name;

        //Update species choice rank
        let options = this.nnClient.getSpeciesChoiceOptions(unfinishedTeam);
        let decision = options.find(option => option.species === self.team[teamIndex].species);
        this.rank = math.multiply(this.rank, decision.probability);

        //Update level choice rank
        options = this.nnClient.getLevelChoiceOptions(unfinishedTeam);
        decision = options.find(option => option.level === self.team[teamIndex].level);
        this.rank = math.multiply(this.rank, decision.probability);

        return confirmedPokemon;
    }

    isStillPossible(battle){
        let opponentTeam = battle.p2.pokemon
        for(let oppTeamIndex in opponentTeam){
            let simulatedPokemon = this.team.find(simulatedPokemon => simulatedPokemon.species === opponentTeam[oppTeamIndex].speciesid);
            if(!simulatedPokemon) return false;
            if(opponentTeam[oppTeamIndex].level != simulatedPokemon.level) return false;
            
            for(let baseMove of opponentTeam[oppTeamIndex].baseMoveSlots){
                if(!simulatedPokemon.moves.find(move => move === baseMove.id))
                    return false;
            }
        }
        return true;
    }

    getRank(){
        return this.rank;
    }
}

module.exports = PossibleTeam;