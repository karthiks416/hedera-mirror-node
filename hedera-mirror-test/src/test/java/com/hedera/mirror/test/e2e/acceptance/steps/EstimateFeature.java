/*
 * Copyright (C) 2023 Hedera Hashgraph, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.hedera.mirror.test.e2e.acceptance.steps;

import static com.hedera.mirror.test.e2e.acceptance.client.TokenClient.TokenNameEnum.FUNGIBLE;
import static com.hedera.mirror.test.e2e.acceptance.util.TestUtil.to32BytesString;
import static com.hedera.mirror.test.e2e.acceptance.util.TestUtil.to32BytesStringRightPad;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.hedera.hashgraph.sdk.PrivateKey;
import com.hedera.hashgraph.sdk.TokenId;
import com.hedera.mirror.test.e2e.acceptance.client.AccountClient;
import com.hedera.mirror.test.e2e.acceptance.client.TokenClient;
import com.hedera.mirror.test.e2e.acceptance.props.ContractCallRequest;
import com.hedera.mirror.test.e2e.acceptance.props.ExpandedAccountId;
import com.hedera.mirror.test.e2e.acceptance.response.ContractCallResponse;
import io.cucumber.java.en.And;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import java.io.IOException;
import lombok.CustomLog;
import lombok.Getter;
import lombok.RequiredArgsConstructor;
import org.apache.commons.lang3.RandomStringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.reactive.function.client.WebClientResponseException;

@CustomLog
@RequiredArgsConstructor(onConstructor = @__(@Autowired))
public class EstimateFeature extends AbstractEstimateFeature {
    private static final String HEX_DIGITS = "0123456789abcdef";
    private static final String RANDOM_ADDRESS = to32BytesString(RandomStringUtils.random(40, HEX_DIGITS));
    private final TokenClient tokenClient;
    private final AccountClient accountClient;
    private DeployedContract deployedContract;
    private String contractSolidityAddress;

    private TokenId fungibleTokenId;
    private String newAccountEvmAddress;
    private ExpandedAccountId receiverAccountId;

    @Given("I successfully create EstimateGas contract from contract bytes")
    public void createNewEstimateContract() throws IOException {
        deployedContract = getContract(ContractResource.ESTIMATE_GAS_TEST_CONTRACT);
        contractSolidityAddress = deployedContract.contractId().toSolidityAddress();
        newAccountEvmAddress =
                PrivateKey.generateECDSA().getPublicKey().toEvmAddress().toString();
        receiverAccountId = accountClient.getAccount(AccountClient.AccountNameEnum.BOB);
    }

    @Given("I successfully create fungible token")
    public void createFungibleToken() {
        fungibleTokenId = tokenClient.getToken(FUNGIBLE).tokenId();
    }

    @And("lower deviation is {int}% and upper deviation is {int}%")
    public void setDeviations(int lower, int upper) {
        lowerDeviation = lower;
        upperDeviation = upper;
    }

    @Then("I call estimateGas without arguments that multiplies two numbers")
    public void multiplyEstimateCall() {
        validateGasEstimation(
                ContractMethods.MULTIPLY_SIMPLE_NUMBERS.getSelector(),
                ContractMethods.MULTIPLY_SIMPLE_NUMBERS.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function msgSender")
    public void msgSenderEstimateCall() {
        validateGasEstimation(
                ContractMethods.MESSAGE_SENDER.getSelector(),
                ContractMethods.MESSAGE_SENDER.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function tx origin")
    public void txOriginEstimateCall() {
        validateGasEstimation(
                ContractMethods.TX_ORIGIN.getSelector(),
                ContractMethods.TX_ORIGIN.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function messageValue")
    public void msgValueEstimateCall() {
        validateGasEstimation(
                ContractMethods.MESSAGE_VALUE.getSelector(),
                ContractMethods.MESSAGE_VALUE.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function messageSigner")
    public void msgSignerEstimateCall() {
        validateGasEstimation(
                ContractMethods.MESSAGE_SIGNER.getSelector(),
                ContractMethods.MESSAGE_SIGNER.getActualGas(),
                contractSolidityAddress);
    }

    @RetryAsserts
    @Then("I call estimateGas with function balance of address")
    public void addressBalanceEstimateCall() {
        validateGasEstimation(
                ContractMethods.ADDRESS_BALANCE.getSelector() + RANDOM_ADDRESS,
                ContractMethods.ADDRESS_BALANCE.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that changes contract slot information"
            + " by updating global contract field with the passed argument")
    public void updateCounterEstimateCall() {
        // update value with amount of 5
        String updateValue = to32BytesString("5");
        validateGasEstimation(
                ContractMethods.UPDATE_COUNTER.getSelector() + updateValue,
                ContractMethods.UPDATE_COUNTER.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that successfully deploys a new smart contract via CREATE op code")
    public void deployContractViaCreateOpcodeEstimateCall() {
        validateGasEstimation(
                ContractMethods.DEPLOY_CONTRACT_VIA_CREATE_OPCODE.getSelector(),
                ContractMethods.DEPLOY_CONTRACT_VIA_CREATE_OPCODE.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that successfully deploys a new smart contract via CREATE2 op code")
    public void deployContractViaCreateTwoOpcodeEstimateCall() {
        validateGasEstimation(
                ContractMethods.DEPLOY_CONTRACT_VIA_CREATE_TWO_OPCODE.getSelector(),
                ContractMethods.DEPLOY_CONTRACT_VIA_CREATE_TWO_OPCODE.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that makes a static call to a method from a different contract")
    public void staticCallToContractEstimateCall() {
        var contractCallGetMockAddress = ContractCallRequest.builder()
                .data(ContractMethods.GET_MOCK_ADDRESS.getSelector())
                .to(contractSolidityAddress)
                .estimate(false)
                .build();
        var getMockAddressResponse =
                mirrorClient.contractsCall(contractCallGetMockAddress).getResultAsAddress();
        validateGasEstimation(
                ContractMethods.STATIC_CALL_TO_CONTRACT.getSelector()
                        + to32BytesString(getMockAddressResponse)
                        + to32BytesStringRightPad(ContractMethods.GET_ADDRESS.getSelector()),
                ContractMethods.STATIC_CALL_TO_CONTRACT.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that makes a delegate call to a method from a different contract")
    public void delegateCallToContractEstimateCall() {
        var contractCallGetMockAddress = ContractCallRequest.builder()
                .data(ContractMethods.GET_MOCK_ADDRESS.getSelector())
                .to(contractSolidityAddress)
                .estimate(false)
                .build();
        var getMockAddressResponse =
                mirrorClient.contractsCall(contractCallGetMockAddress).getResultAsAddress();
        validateGasEstimation(
                ContractMethods.DELEGATE_CALL_TO_CONTRACT.getSelector()
                        + to32BytesString(getMockAddressResponse)
                        + to32BytesStringRightPad(ContractMethods.GET_ADDRESS.getSelector()),
                ContractMethods.DELEGATE_CALL_TO_CONTRACT.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that makes a call code to a method from a different contract")
    public void callCodeToContractEstimateCall() {
        var contractCallGetMockAddress = ContractCallRequest.builder()
                .data(ContractMethods.GET_MOCK_ADDRESS.getSelector())
                .to(contractSolidityAddress)
                .estimate(false)
                .build();
        var getMockAddressResponse =
                mirrorClient.contractsCall(contractCallGetMockAddress).getResultAsAddress();
        validateGasEstimation(
                ContractMethods.CALL_CODE_TO_CONTRACT.getSelector()
                        + to32BytesString(getMockAddressResponse)
                        + to32BytesStringRightPad(ContractMethods.GET_ADDRESS.getSelector()),
                ContractMethods.CALL_CODE_TO_CONTRACT.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that performs LOG0, LOG1, LOG2, LOG3, LOG4 operations")
    public void logsEstimateCall() {
        validateGasEstimation(
                ContractMethods.LOGS.getSelector(), ContractMethods.LOGS.getActualGas(), contractSolidityAddress);
    }

    @Then("I call estimateGas with function that performs self destruct")
    public void destroyEstimateCall() {
        validateGasEstimation(
                ContractMethods.DESTROY.getSelector(), ContractMethods.DESTROY.getActualGas(), contractSolidityAddress);
    }

    @Then("I call estimateGas with request body that contains wrong method signature")
    public void wrongMethodSignatureEstimateCall() {
        var contractCallRequestBody = ContractCallRequest.builder()
                .data(ContractMethods.WRONG_METHOD_SIGNATURE.getSelector())
                .to(contractSolidityAddress)
                .estimate(true)
                .build();
        assertThatThrownBy(() -> mirrorClient.contractsCall(contractCallRequestBody))
                .isInstanceOf(WebClientResponseException.class)
                .hasMessageContaining("400 Bad Request from POST");
    }

    @Then("I call estimateGas with wrong encoded parameter")
    public void wrongEncodedParameterEstimateCall() {
        // wrong encoded address -> it should contain leading zero's equal to 64 characters
        String wrongEncodedAddress = "5642";
        var contractCallRequestBody = ContractCallRequest.builder()
                .data(ContractMethods.ADDRESS_BALANCE.getSelector() + wrongEncodedAddress)
                .to(contractSolidityAddress)
                .estimate(true)
                .build();
        assertThatThrownBy(() -> mirrorClient.contractsCall(contractCallRequestBody))
                .isInstanceOf(WebClientResponseException.class)
                .hasMessageContaining("400 Bad Request from POST");
    }

    @Then("I call estimateGas with non-existing from address in the request body")
    public void wrongFromParameterEstimateCall() {
        var contractCallRequestBody = ContractCallRequest.builder()
                .data(ContractMethods.MESSAGE_SIGNER.getSelector())
                .to(contractSolidityAddress)
                .from(newAccountEvmAddress)
                .estimate(true)
                .build();
        ContractCallResponse msgSignerResponse = mirrorClient.contractsCall(contractCallRequestBody);
        int estimatedGas = msgSignerResponse.getResultAsNumber().intValue();

        assertTrue(isWithinDeviation(
                ContractMethods.MESSAGE_SIGNER.getActualGas(), estimatedGas, lowerDeviation, upperDeviation));
    }

    @Then("I call estimateGas with function that makes a call to invalid smart contract")
    public void callToInvalidSmartContractEstimateCall() {
        validateGasEstimation(
                ContractMethods.CALL_TO_INVALID_CONTRACT.getSelector() + RANDOM_ADDRESS,
                ContractMethods.CALL_TO_INVALID_CONTRACT.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that makes a delegate call to invalid smart contract")
    public void delegateCallToInvalidSmartContractEstimateCall() {
        validateGasEstimation(
                ContractMethods.DELEGATE_CALL_TO_INVALID_CONTRACT.getSelector() + RANDOM_ADDRESS,
                ContractMethods.DELEGATE_CALL_TO_INVALID_CONTRACT.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that makes a static call to invalid smart contract")
    public void staticCallToInvalidSmartContractEstimateCall() {
        validateGasEstimation(
                ContractMethods.STATIC_CALL_TO_INVALID_CONTRACT.getSelector() + RANDOM_ADDRESS,
                ContractMethods.STATIC_CALL_TO_INVALID_CONTRACT.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that makes a call code to invalid smart contract")
    public void callCodeToInvalidSmartContractEstimateCall() {
        validateGasEstimation(
                ContractMethods.CALL_CODE_TO_INVALID_CONTRACT.getSelector() + RANDOM_ADDRESS,
                ContractMethods.CALL_CODE_TO_INVALID_CONTRACT.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that makes call to an external contract function")
    public void callCodeToExternalContractFunction() {
        validateGasEstimation(
                ContractMethods.CALL_CODE_TO_EXTERNAL_CONTRACT_FUNCTION.getSelector()
                        + to32BytesString("1")
                        + to32BytesString(contractSolidityAddress),
                ContractMethods.CALL_CODE_TO_EXTERNAL_CONTRACT_FUNCTION.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that makes delegate call to an external contract function")
    public void delegateCallCodeToExternalContractFunction() {
        validateGasEstimation(
                ContractMethods.DELEGATE_CALL_CODE_TO_EXTERNAL_CONTRACT_FUNCTION.getSelector()
                        + to32BytesString("1")
                        + to32BytesString(contractSolidityAddress),
                ContractMethods.DELEGATE_CALL_CODE_TO_EXTERNAL_CONTRACT_FUNCTION.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that makes call to an external contract view function")
    public void callCodeToExternalContractViewFunction() {
        validateGasEstimation(
                ContractMethods.CALL_CODE_TO_EXTERNAL_CONTRACT_FUNCTION_VIEW.getSelector()
                        + to32BytesString("1")
                        + to32BytesString(contractSolidityAddress),
                ContractMethods.CALL_CODE_TO_EXTERNAL_CONTRACT_FUNCTION_VIEW.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that makes a state update to a contract")
    public void stateUpdateContractFunction() {
        // making 5 times to state update
        validateGasEstimation(
                ContractMethods.STATE_UPDATE_OF_CONTRACT.getSelector() + to32BytesString("5"),
                ContractMethods.STATE_UPDATE_OF_CONTRACT.getActualGas(),
                contractSolidityAddress);
    }

    @Then(
            "I call estimateGas with function that makes a state update to a contract several times and estimateGas is higher")
    public void progressiveStateUpdateContractFunction() {
        // making 5 times to state update
        var contractCallRequestStateUpdateWithFive = ContractCallRequest.builder()
                .data(ContractMethods.STATE_UPDATE_OF_CONTRACT.getSelector() + to32BytesString("5"))
                .to(contractSolidityAddress)
                .estimate(true)
                .build();
        ContractCallResponse fiveStateUpdatesResponse =
                mirrorClient.contractsCall(contractCallRequestStateUpdateWithFive);
        int estimatedGasOfFiveStateUpdates =
                fiveStateUpdatesResponse.getResultAsNumber().intValue();
        // making 10 times to state update
        var contractCallRequestStateUpdateWithTen = ContractCallRequest.builder()
                .data(ContractMethods.STATE_UPDATE_OF_CONTRACT.getSelector() + to32BytesString("10"))
                .to(contractSolidityAddress)
                .estimate(true)
                .build();
        ContractCallResponse tenStateUpdatesResponse =
                mirrorClient.contractsCall(contractCallRequestStateUpdateWithTen);
        int estimatedGasOfTenStateUpdates =
                tenStateUpdatesResponse.getResultAsNumber().intValue();
        // verifying that estimateGas for 10 state updates is higher than 5 state updates
        assertTrue(estimatedGasOfTenStateUpdates > estimatedGasOfFiveStateUpdates);
    }

    @Then("I call estimateGas with function that executes reentrancy attack with call")
    public void reentrancyCallAttackFunction() {
        validateGasEstimation(
                ContractMethods.REENTRANCY_CALL_ATTACK.getSelector() + RANDOM_ADDRESS + to32BytesString("10000000000"),
                ContractMethods.REENTRANCY_CALL_ATTACK.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that executes gasLeft")
    public void getGasLeftContractFunction() {
        validateGasEstimation(
                ContractMethods.GET_GAS_LEFT.getSelector(),
                ContractMethods.GET_GAS_LEFT.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that executes positive nested calls")
    public void positiveNestedCallsFunction() {
        validateGasEstimation(
                ContractMethods.NESTED_CALLS_POSITIVE.getSelector()
                        + to32BytesString("1")
                        + to32BytesString("10")
                        + to32BytesString(contractSolidityAddress),
                ContractMethods.NESTED_CALLS_POSITIVE.getActualGas(),
                contractSolidityAddress);
    }

    @Then("I call estimateGas with function that executes limited nested calls")
    public void limitedNestedCallsFunction() {
        // verify that after exceeding a number of nested calls that the estimated gas would return the same
        // we will execute with 500, 1024 and 1025, and it should return the same estimatedGas
        validateGasEstimation(
                ContractMethods.NESTED_CALLS_LIMITED.getSelector()
                        + to32BytesString("1")
                        + to32BytesString("500")
                        + to32BytesString(contractSolidityAddress),
                ContractMethods.NESTED_CALLS_LIMITED.getActualGas(),
                contractSolidityAddress);
        validateGasEstimation(
                ContractMethods.NESTED_CALLS_LIMITED.getSelector()
                        + to32BytesString("1")
                        + to32BytesString("1024")
                        + to32BytesString(contractSolidityAddress),
                ContractMethods.NESTED_CALLS_LIMITED.getActualGas(),
                contractSolidityAddress);
        validateGasEstimation(
                ContractMethods.NESTED_CALLS_LIMITED.getSelector()
                        + to32BytesString("1")
                        + to32BytesString("1025")
                        + to32BytesString(contractSolidityAddress),
                ContractMethods.NESTED_CALLS_LIMITED.getActualGas());
    }

    @Then("I call estimateGas with IERC20 token transfer using long zero address as receiver")
    public void ierc20TransferWithLongZeroAddressForReceiver() {
        var transferCall = ContractCallRequest.builder()
                .data(ContractMethods.IERC20_TOKEN_TRANSFER.getSelector()
                        + to32BytesString(receiverAccountId.getAccountId().toSolidityAddress())
                        + to32BytesString("1"))
                .to(fungibleTokenId.toSolidityAddress())
                .estimate(true)
                .build();
        ContractCallResponse transferCallResponse = mirrorClient.contractsCall(transferCall);

        assertTrue(isWithinDeviation(
                ContractMethods.IERC20_TOKEN_TRANSFER.getActualGas(),
                transferCallResponse.getResultAsNumber().intValue(),
                lowerDeviation,
                upperDeviation));
    }

    @Then("I call estimateGas with IERC20 token transfer using evm address as receiver")
    public void ierc20TransferWithEvmAddressForReceiver() {
        var accountInfo = mirrorClient.getAccountDetailsByAccountId(receiverAccountId.getAccountId());
        var transferCall = ContractCallRequest.builder()
                .data(ContractMethods.IERC20_TOKEN_TRANSFER.getSelector()
                        + to32BytesString(accountInfo.getEvmAddress().replace("0x", ""))
                        + to32BytesString("1"))
                .to(fungibleTokenId.toSolidityAddress())
                .estimate(true)
                .build();
        ContractCallResponse transferCallResponse = mirrorClient.contractsCall(transferCall);

        assertTrue(isWithinDeviation(
                ContractMethods.IERC20_TOKEN_TRANSFER.getActualGas(),
                transferCallResponse.getResultAsNumber().intValue(),
                lowerDeviation,
                upperDeviation));
    }

    @Then("I call estimateGas with IERC20 token approve using evm address as receiver")
    public void ierc20ApproveWithEvmAddressForReceiver() {
        var accountInfo = mirrorClient.getAccountDetailsByAccountId(receiverAccountId.getAccountId());
        var approveCall = ContractCallRequest.builder()
                .data(ContractMethods.IERC20_TOKEN_APPROVE.getSelector()
                        + to32BytesString(accountInfo.getEvmAddress().replace("0x", ""))
                        + to32BytesString("1"))
                .to(fungibleTokenId.toSolidityAddress())
                .estimate(true)
                .build();
        ContractCallResponse approveCallResponse = mirrorClient.contractsCall(approveCall);

        assertTrue(isWithinDeviation(
                ContractMethods.IERC20_TOKEN_APPROVE.getActualGas(),
                approveCallResponse.getResultAsNumber().intValue(),
                lowerDeviation,
                upperDeviation));
    }

    @Then("I call estimateGas with IERC20 token associate using evm address as receiver")
    public void ierc20AssociateWithEvmAddressForReceiver() {
        var accountInfo = mirrorClient.getAccountDetailsByAccountId(receiverAccountId.getAccountId());
        var associateCall = ContractCallRequest.builder()
                .data(ContractMethods.IERC20_TOKEN_ASSOCIATE.getSelector()
                        + to32BytesString(accountInfo.getEvmAddress().replace("0x", "")))
                .to(fungibleTokenId.toSolidityAddress())
                .estimate(true)
                .build();
        ContractCallResponse associateCallResponse = mirrorClient.contractsCall(associateCall);

        assertTrue(isWithinDeviation(
                ContractMethods.IERC20_TOKEN_ASSOCIATE.getActualGas(),
                associateCallResponse.getResultAsNumber().intValue(),
                lowerDeviation,
                upperDeviation));
    }

    @Then("I call estimateGas with IERC20 token dissociate using evm address as receiver")
    public void ierc20DissociateWithEvmAddressForReceiver() {
        var accountInfo = mirrorClient.getAccountDetailsByAccountId(receiverAccountId.getAccountId());
        var dissociateCall = ContractCallRequest.builder()
                .data(ContractMethods.IERC20_TOKEN_DISSOCIATE.getSelector()
                        + to32BytesString(accountInfo.getEvmAddress().replace("0x", "")))
                .to(fungibleTokenId.toSolidityAddress())
                .estimate(true)
                .build();
        ContractCallResponse dissociateCallResponse = mirrorClient.contractsCall(dissociateCall);

        assertTrue(isWithinDeviation(
                ContractMethods.IERC20_TOKEN_DISSOCIATE.getActualGas(),
                dissociateCallResponse.getResultAsNumber().intValue(),
                lowerDeviation,
                upperDeviation));
    }

    private void validateGasEstimation(String selector, int actualGasUsed) {
        var contractCallRequestBody = ContractCallRequest.builder()
                .data(selector)
                .to(contractSolidityAddress)
                .estimate(true)
                .build();
        ContractCallResponse msgSenderResponse = mirrorClient.contractsCall(contractCallRequestBody);
        int estimatedGas = msgSenderResponse.getResultAsNumber().intValue();

        assertTrue(isWithinDeviation(actualGasUsed, estimatedGas, lowerDeviation, upperDeviation));
    }

    /**
     * Estimate gas values are hardcoded at this moment until we get better solution such as actual gas used returned
     * from the consensus node. It will be changed in future PR when actualGasUsed field is added to the protobufs.
     */
    @Getter
    @RequiredArgsConstructor
    private enum ContractMethods {
        ADDRESS_BALANCE("3ec4de35", 24030),
        CALL_CODE_TO_CONTRACT("ac7e2758", 26398),
        CALL_CODE_TO_EXTERNAL_CONTRACT_FUNCTION("4929af37", 26100),
        CALL_CODE_TO_EXTERNAL_CONTRACT_FUNCTION_VIEW("fa5e414e", 22272),
        CALL_CODE_TO_INVALID_CONTRACT("e080b4aa", 24031),
        CALL_TO_INVALID_CONTRACT("70079963", 24374),
        DELEGATE_CALL_CODE_TO_EXTERNAL_CONTRACT_FUNCTION("80f009b6", 24712),
        DELEGATE_CALL_TO_CONTRACT("d3b6e741", 26417),
        DELEGATE_CALL_TO_INVALID_CONTRACT("7df6ee27", 24350),
        DEPLOY_CONTRACT_VIA_CREATE_OPCODE("6e6662b9", 53477),
        DEPLOY_CONTRACT_VIA_CREATE_TWO_OPCODE("dbb6f04a", 55693),
        DESTROY("83197ef0", 26171),
        GET_ADDRESS("38cc4831", 0),
        GET_GAS_LEFT("51be4eaa", 21326),
        GET_MOCK_ADDRESS("14a7862c", 0),
        LOGS("74259795", 28757),
        MESSAGE_SENDER("d737d0c7", 21290),
        MESSAGE_SIGNER("ec3e88cf", 21252),
        MESSAGE_VALUE("ddf363d7", 21234),
        MULTIPLY_SIMPLE_NUMBERS("0ec1551d", 21227),
        NESTED_CALLS_LIMITED("bb376a96", 525255),
        NESTED_CALLS_POSITIVE("bb376a96", 45871),
        REENTRANCY_CALL_ATTACK("e7df080e", 55818),
        REENTRANCY_TRANSFER_ATTACK("ffaf0890", 55500),
        STATIC_CALL_TO_CONTRACT("ef0a4eac", 26416),
        STATIC_CALL_TO_INVALID_CONTRACT("41f32f0c", 24394),
        STATE_UPDATE_OF_CONTRACT("5256b99d", 30500),
        TX_ORIGIN("f96757d1", 21289),
        UPDATE_COUNTER("c648049d", 26279),
        WRONG_METHOD_SIGNATURE("ffffffff", 0),
        IERC20_TOKEN_TRANSFER("a9059cbb", 37837),
        IERC20_TOKEN_APPROVE("095ea7b3", 727978),
        IERC20_TOKEN_ASSOCIATE("0a754de6", 727972),
        IERC20_TOKEN_DISSOCIATE("5c9217e0", 727972);
        private final String selector;
        private final int actualGas;
    }
}
